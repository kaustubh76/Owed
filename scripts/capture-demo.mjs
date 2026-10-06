#!/usr/bin/env node
/**
 * Capture a real run of the add-on, so a replay can be built from it.
 *
 * This boots the actual MCP server and the actual merchant agents, walks the actual
 * OAuth 2.1 flow, drives the server with a real MCP client over Streamable HTTP, and
 * writes everything it saw to docs/demo-capture.json.
 *
 * The point is that the replay page contains no invented numbers. Every figure, every
 * spoken line, every JSON-RPC frame and every negotiation round in it came out of this
 * script talking to the real thing — which is also why this file is committed: the
 * capture is only worth trusting if the run that produced it can be repeated.
 *
 * Usage:
 *   pnpm build && node scripts/capture-demo.mjs
 *
 * Its output is excluded from biome in biome.json. Formatting a generated file means the
 * next capture run leaves the tree dirty and fails lint, which would turn re-running this
 * script — the whole point of committing it — into a chore.
 *
 * Three things here are load-bearing and look optional:
 *
 *  - `OWED_MERCHANTS_URL` must be set, so the server talks to the merchant agents over
 *    HTTP. Without it `main.ts` falls back to in-process merchants, which accept no
 *    recourse log and record nothing — the negotiation would come back empty while
 *    everything appeared to work.
 *
 *  - `OWED_DB` and `OWED_DYNAMO_TABLE` must stay unset, so the seeded week is written
 *    fresh and `prm_011` is still unfiled. Against a persistent ledger `claim_file`
 *    takes its idempotent path, returns the claim it already has, and never negotiates.
 *
 *  - evidence ids are derived from `promise_check`, never hardcoded. They are generated
 *    per seed and a literal would rot silently into an `isError` result.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import * as z from "zod/v4";
import { linkAccount } from "../packages/mcp-server/dist/index.js";

const SERVER_PORT = process.env.OWED_PORT ?? "3997";
const MERCHANTS_PORT = process.env.OWED_MERCHANTS_PORT ?? "3996";
const BASE_URL = new URL(`http://127.0.0.1:${SERVER_PORT}`);
const BOOT_TIMEOUT_MS = 40_000;
const OUT = new URL("../docs/demo-capture.json", import.meta.url);

/** Ports 3997/3996 so a running `pnpm demo` (3939/3941) is not disturbed. */

const REQUIRED_BUILDS = [
  "packages/mcp-server/dist/main.js",
  "packages/mcp-server/dist/index.js",
  "packages/merchant-agents/dist/bin/serve.js",
  "packages/ui-views/dist/views/ledger/index.html",
  "packages/ui-views/dist/views/claim/index.html",
  "packages/ui-views/dist/views/evidence/index.html",
];

function fail(message) {
  process.stderr.write(`\n✗ ${message}\n`);
  process.exit(1);
}

for (const path of REQUIRED_BUILDS) {
  if (!existsSync(path)) fail(`${path} is missing — run \`pnpm build\` first`);
}

// ── the week, in scenario time ───────────────────────────────────────────────────────
//
// Instants from packages/mcp-server/src/seed/storyboard.ts. The week is Mon 2026-10-05
// in America/Los_Angeles (-07:00); these are the same instants in UTC, because that is
// what /control/clock echoes back.
const POSITIONS = [
  {
    id: "monday-open",
    instant: "2026-10-05T07:00:00.000Z",
    label: "Mon 00:00",
    note: "The scrubber's left edge. Nothing has happened yet, and the ledger says so.",
  },
  {
    id: "midweek",
    instant: "2026-10-07T01:40:00.000Z",
    label: "Tue 18:40",
    note: "Mid-week. The first claim has already been argued and paid, so the ledger is partly filled and one `claim_recovered` commitment is due.",
  },
  {
    id: "suspected",
    instant: "2026-10-12T00:10:00.000Z",
    label: "Sun 17:10",
    note: "prm_010 is Suspected on 20% coverage. Owed refuses to claim it. The refusal is the product.",
  },
  {
    // The proactive beat. Checked against the capture rather than assumed: this is the
    // first instant where `commitmentsDue` returns a `promise_breached` event carrying an
    // offer, which is the thing Owed would say unprompted and the thing Alexa+ add-ons
    // have no channel for.
    id: "proactive",
    instant: "2026-10-12T01:25:00.000Z",
    label: "Sun 18:25",
    note: "prm_011 is Breached and unfiled. This is where Owed speaks first — a `promise_breached` commitment whose offer is \"File it\". Alexa+ add-ons have no proactive channel, so the home badges every one of these `simulated proactive`.",
  },
  {
    id: "query",
    instant: "2026-10-12T02:30:00.000Z",
    label: "Sun 19:30",
    note: "The storyboard's starting point: \"Alexa, what am I owed?\"",
  },
];

// ── processes ────────────────────────────────────────────────────────────────────────
// Lifted from scripts/verify-ui.mjs, which already solved this.

const children = [];
function start(name, command, args, env = {}, unset = []) {
  const childEnv = { ...process.env, ...env };
  // Deleted, not blanked. `main.ts:95` tests these with `!== undefined`, so OWED_DB=""
  // counts as configured — setting both to "" trips "the ledger has one home" and the
  // server refuses to boot.
  for (const key of unset) delete childEnv[key];
  const child = spawn(command, args, { env: childEnv, stdio: "ignore" });
  children.push({ name, child });
  return child;
}
function stopAll() {
  for (const { child } of children) if (!child.killed) child.kill("SIGTERM");
}
process.on("exit", stopAll);
process.on("SIGINT", () => {
  stopAll();
  process.exit(130);
});

async function waitFor(label, check) {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(300);
  }
  throw new Error(`${label} did not come up within ${BOOT_TIMEOUT_MS}ms`);
}
const reachable = (url) =>
  fetch(url)
    .then((r) => r.ok)
    .catch(() => false);

process.stdout.write("── booting ──\n");

start("merchants", process.execPath, ["packages/merchant-agents/dist/bin/serve.js"], {
  OWED_MERCHANTS_PORT: MERCHANTS_PORT,
});
await waitFor("merchant agents", () => reachable(`http://127.0.0.1:${MERCHANTS_PORT}/merchants`));
process.stdout.write(`  merchant agents  :${MERCHANTS_PORT}\n`);

start(
  "server",
  process.execPath,
  ["packages/mcp-server/dist/main.js"],
  {
    OWED_PORT: SERVER_PORT,
    // Load-bearing: see the header. Without this there is no recourse log.
    OWED_MERCHANTS_URL: `http://127.0.0.1:${MERCHANTS_PORT}`,
  },
  // So the week reseeds and prm_011 is unfiled, whatever the caller's shell has set.
  ["OWED_DB", "OWED_DYNAMO_TABLE"],
);
await waitFor("MCP server", () =>
  reachable(`http://127.0.0.1:${SERVER_PORT}/.well-known/oauth-protected-resource`),
);
process.stdout.write(`  MCP server       :${SERVER_PORT}\n`);

// ── a real client, with the real OAuth walk ──────────────────────────────────────────

const { accessToken, scope, expiresInSeconds } = await linkAccount({
  baseUrl: BASE_URL,
  clientId: "owed-simulated-home",
});
process.stdout.write(`  linked           scope "${scope}", ${expiresInSeconds}s\n`);

/** Every MCP frame this run produced, in the order it crossed the wire. */
const mcpFrames = [];

/**
 * Keep the frames, drop the view bodies.
 *
 * A `resources/read` result carries a whole ~453 KB view bundle, and three of them are
 * 90% of this file. The bundles are published beside the replay as their own files and
 * verified by digest below, so storing them a second time inside the frame log would
 * make the capture unreadable to buy nothing. Everything else about the frame — the
 * envelope, the uri, the mime type, the CSP — is kept exactly as it crossed the wire.
 */
function elideViewBodies(message) {
  const contents = message?.result?.contents;
  if (!Array.isArray(contents)) return message;
  return {
    ...message,
    result: {
      ...message.result,
      contents: contents.map((item) =>
        typeof item?.text === "string" && item.text.length > 4096
          ? {
              ...item,
              text: undefined,
              "owed/elided": {
                reason: "view bundle published as its own file; see `views` in this capture",
                bytes: Buffer.byteLength(item.text),
                sha256: createHash("sha256").update(item.text).digest("hex"),
              },
            }
          : item,
      ),
    },
  };
}
const record = (direction, message) => {
  mcpFrames.push({ direction, at: new Date().toISOString(), message: elideViewBodies(message) });
};

const transport = new StreamableHTTPClientTransport(new URL("/mcp", BASE_URL), {
  requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
});

// Tapped the way apps/brain/src/session.ts does it: wrap `send` before connecting and
// `onmessage` after, because `connect` installs its own handler over anything set first.
const send = transport.send.bind(transport);
transport.send = (message, options) => {
  record("out", message);
  return send(message, options);
};

const client = new Client(
  { name: "owed-demo-capture", version: "1.0.0" },
  {
    // Declared so `claim_file` will ask rather than assume, which is the whole point of
    // capturing the confirmation step.
    capabilities: { elicitation: {} },
    versionNegotiation: { mode: "auto" },
  },
);

/**
 * What the household answers when asked. Swapped between captures rather than
 * registering a second handler, because re-registering the same method is not something
 * the client promises to honour.
 */
let answer = () => ({ action: "decline" });
const questions = [];
client.setRequestHandler(
  "elicitation/create",
  { params: z.object({ message: z.string() }).catchall(z.unknown()) },
  (params) => {
    questions.push(params.message);
    return answer();
  },
);

await client.connect(transport);

// After `connect`, because it installs its own handler over anything set before.
const onmessage = transport.onmessage;
transport.onmessage = (message, extra) => {
  record("in", message);
  onmessage?.call(transport, message, extra);
};

process.stdout.write("  connected\n\n");

// ── helpers ──────────────────────────────────────────────────────────────────────────

const control = (path, init) =>
  fetch(new URL(path, BASE_URL), init).then((r) => {
    if (!r.ok) throw new Error(`${path} answered ${r.status}`);
    return r.json();
  });

async function setClock(instant) {
  return control("/control/clock", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ instant }),
  });
}

/**
 * Tool results are kept whole, `isError` included.
 *
 * A refusal is not a failed capture — `prm_010` at 20% coverage and a promise already
 * kept both answer `isError: true`, and those answers are the product's best argument.
 * Dropping them would leave a replay that only ever says yes.
 */
async function callTool(name, args) {
  const result = await client.callTool({ name, arguments: args });
  return {
    name,
    arguments: args,
    isError: result.isError === true,
    spoken: result.content?.find((c) => c.type === "text")?.text ?? null,
    structuredContent: result.structuredContent ?? null,
    resourceUri: result._meta?.ui?.resourceUri ?? null,
  };
}

let recourseCursor = 0;
async function drainRecourse() {
  const { frames, next } = await control(`/control/recourse?since=${recourseCursor}`);
  recourseCursor = next;
  return frames;
}

// ── capture ──────────────────────────────────────────────────────────────────────────

const range = await control("/control/clock");
const capture = {
  $comment:
    "Captured from a real run by scripts/capture-demo.mjs. Not hand-written. Re-runnable: pnpm build && node scripts/capture-demo.mjs",
  captured_at: new Date().toISOString(),
  commit: null, // filled in below
  server: { info: client.getServerVersion?.() ?? null, range },
  tools: (await client.listTools()).tools.map((t) => ({
    name: t.name,
    title: t.title ?? null,
    description: t.description ?? null,
    inputSchema: t.inputSchema ?? null,
    resourceUri: t._meta?.ui?.resourceUri ?? null,
  })),
  positions: [],
  claim_file: {},
  views: [],
  recourse: [],
  mcpFrames: [],
};

process.stdout.write("── capturing positions ──\n");

for (const position of POSITIONS) {
  await setClock(position.instant);

  const ledger = await callTool("ledger_summary", {});
  const ledgerMonth = await callTool("ledger_summary", { period: "month" });
  const promises = await callTool("promises_list", {});

  // Pick a promise worth inspecting at this instant, preferring the storyboard's own
  // beats, and derive its evidence id rather than assuming one.
  const items = ledger.structuredContent?.items ?? [];
  const interesting =
    items.find((i) => i.promise_id === "prm_010") ??
    items.find((i) => i.promise_id === "prm_002") ??
    items[0];

  let evidence = null;
  let evidenceItem = null;
  if (interesting) {
    evidence = await callTool("promise_check", { promise_id: interesting.promise_id });
    const firstEvidence = evidence.structuredContent?.items?.[0];
    if (firstEvidence) {
      evidenceItem = await callTool("evidence_get", {
        evidence_id: firstEvidence.evidence_id,
        promise_id: interesting.promise_id,
      });
    }
  }

  const withClaim = items.find((i) => i.claim_id);
  const claim = withClaim ? await callTool("claim_status", { claim_id: withClaim.claim_id }) : null;

  const { events } = await control("/control/commitments");

  capture.positions.push({
    ...position,
    ledger,
    ledgerMonth,
    promises,
    evidence,
    evidenceItem,
    claim,
    commitments: events,
  });

  const t = ledger.structuredContent;
  process.stdout.write(
    `  ${position.label.padEnd(10)} ${
      t ? `recovered ${t.recovered.minor / 100} · open ${t.open.minor / 100} · ${t.kept} kept` : "—"
    }\n`,
  );
}

// ── the confirmation step, both ways ─────────────────────────────────────────────────
//
// Captured at Sun 18:25 or later, because every tool replays the ledger *to* the clock
// and prm_011 is not breached before then.

process.stdout.write("\n── claim_file ──\n");
await setClock("2026-10-12T02:30:00.000Z");

// Asked, not told. No `confirm` argument, and the client declared elicitation — but a
// declined elicitation and a never-asked one are different things, so capture the
// refusal path explicitly.
answer = () => ({ action: "decline" });
capture.claim_file.declined = await callTool("claim_file", { promise_id: "prm_011" });
process.stdout.write(`  declined   -> ${capture.claim_file.declined.spoken}\n`);

answer = () => ({ action: "accept", content: { confirm: true, attach_evidence: true } });
capture.claim_file.accepted = await callTool("claim_file", { promise_id: "prm_011" });
const settled = capture.claim_file.accepted.structuredContent;
process.stdout.write(
  `  accepted   -> ${settled?.state} at ${settled ? settled.settled_amount?.minor / 100 : "—"}, ${settled?.round_count} rounds\n`,
);

// The refusal that matters most: coverage too low to claim honestly.
capture.claim_file.refused = await callTool("claim_file", {
  promise_id: "prm_010",
  confirm: true,
});
process.stdout.write(`  prm_010    -> ${capture.claim_file.refused.spoken}\n`);

capture.recourse = await drainRecourse();
process.stdout.write(`  recourse frames: ${capture.recourse.length}\n`);

// ── the views, read over MCP ─────────────────────────────────────────────────────────
//
// The HTML is ~453 KB each and is published alongside the replay as its own file rather
// than inlined here, so this records what the server served and a digest to prove the
// published copy is the same bytes.

process.stdout.write("\n── views ──\n");
for (const name of ["ledger", "claim", "evidence"]) {
  const uri = `ui://owed/${name}`;
  const read = await client.readResource({ uri });
  const content = read.contents[0];
  const html = content.text ?? "";
  const digest = createHash("sha256").update(html).digest("hex");
  const onDisk = readFileSync(`packages/ui-views/dist/views/${name}/index.html`, "utf8");
  const diskDigest = createHash("sha256").update(onDisk).digest("hex");

  capture.views.push({
    name,
    uri,
    mimeType: content.mimeType ?? null,
    csp: content._meta?.ui?.csp ?? null,
    bytes: Buffer.byteLength(html),
    sha256: digest,
    matchesDist: digest === diskDigest,
  });
  process.stdout.write(
    `  ${name.padEnd(9)} ${content.mimeType}  ${(Buffer.byteLength(html) / 1024).toFixed(0)} KB  dist ${digest === diskDigest ? "identical" : "DIFFERS"}\n`,
  );
}

capture.claim_file.questions = questions;
capture.mcpFrames = mcpFrames;

// ── write ────────────────────────────────────────────────────────────────────────────

try {
  const { execSync } = await import("node:child_process");
  capture.commit = execSync("git rev-parse HEAD", { stdio: ["ignore", "pipe", "ignore"] })
    .toString()
    .trim();
} catch {
  capture.commit = null;
}

await client.close();
stopAll();

writeFileSync(OUT, `${JSON.stringify(capture, null, 2)}\n`);

const bytes = readFileSync(OUT).length;
process.stdout.write(
  `\n✓ docs/demo-capture.json — ${(bytes / 1024).toFixed(0)} KB, ${capture.positions.length} positions, ${capture.recourse.length} recourse frames, ${mcpFrames.length} MCP frames\n`,
);

// A capture that silently lost the interesting parts is worse than a failed one, because
// it would produce a replay that looks complete and shows nothing.
const problems = [];
if (capture.recourse.length === 0) {
  problems.push("no recourse frames — was OWED_MERCHANTS_URL set? in-process merchants log nothing");
}
if (capture.claim_file.accepted?.structuredContent?.state !== "Settled") {
  problems.push(
    `claim_file did not settle (state ${capture.claim_file.accepted?.structuredContent?.state}) — a persistent ledger takes the idempotent path`,
  );
}
if (capture.claim_file.declined?.isError !== true) {
  problems.push("a declined confirmation should be an error result");
}
if (!capture.views.every((v) => v.matchesDist)) {
  problems.push("a served view differs from its built file");
}
if (problems.length > 0) {
  process.stderr.write("\n✗ the capture is incomplete:\n");
  for (const p of problems) process.stderr.write(`  - ${p}\n`);
  process.exit(1);
}
process.stdout.write("  every load-bearing part of the capture is present\n");
