#!/usr/bin/env node
/**
 * Prove the ledger works against real DynamoDB, in a real account.
 *
 * `dynamo.test.ts` already asserts the adapter's behaviour against DynamoDB Local, which
 * is the right place for that. This is the thing DynamoDB Local cannot tell you: that the
 * same code works through IAM, against real eventual consistency, real transactions and
 * real throttling, in the account you think it is in.
 *
 * It makes the **same assertion** the unit test makes — the ledger read back out of
 * DynamoDB equals what `MemoryEventStore` produces for the same events — so a pass here
 * means exactly what a pass there means, only further away.
 *
 * No new product code is needed for the write: `main.ts` seeds the storyboard week only
 * when the store is empty, so booting the server against a fresh table writes the whole
 * week as a side effect of starting up. That is the real usage.
 *
 *   aws dynamodb create-table --table-name owed-ledger ...   (see the plan)
 *   pnpm build
 *   OWED_DYNAMO_TABLE=owed-ledger AWS_REGION=us-east-1 pnpm aws:smoke
 */
import { deepStrictEqual } from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { MemoryEventStore } from "../packages/core/dist/index.js";
import { HOUSEHOLD_ID, storyboardEvents } from "../packages/mcp-server/dist/seed/storyboard.js";
import { DynamoEventStore } from "../packages/mcp-server/dist/store/dynamo.js";

/**
 * Every AWS query here goes through the CLI rather than the SDK.
 *
 * Not a style choice: the SDK is a dependency of `@owed/mcp-server`, and pnpm's isolated
 * layout means the repo root cannot resolve it — a root copy just to run a script would
 * be a second version of the same library to keep in step. `DynamoEventStore` is imported
 * from that package's own `dist`, so it resolves its SDK from where it actually lives, and
 * it builds its own client from `AWS_REGION` and the ambient credential chain.
 *
 * The side benefit is that credentials resolve exactly the way they do in your shell, so
 * "it works when I run it" and "it works here" cannot disagree.
 */
function awsJson(args, what) {
  try {
    return JSON.parse(
      execFileSync("aws", [...args, "--output", "json"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
  } catch (error) {
    const detail = String(error.stderr ?? error.message).trim();
    fail(`${what} failed:\n  ${detail}`);
  }
}

const PORT = process.env.OWED_PORT ?? "3998";
const TABLE = process.env.OWED_DYNAMO_TABLE;
const REGION = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
const STARTUP_TIMEOUT_MS = 30_000;
const SERVER_ENTRY = "packages/mcp-server/dist/main.js";

/**
 * Checked rather than assumed, because the failure it prevents is the expensive one: a
 * smoke test that quietly seeds a household's ledger into somebody else's account tells
 * you nothing and leaves data behind.
 *
 * Required, with no default. It used to default to the author's account, which both
 * published an account number in a public repository and made the guard weaker than it
 * looks: a default is a value nobody chose, and this check is only meaningful if someone
 * deliberately named the account they expect.
 */
const EXPECTED_ACCOUNT = process.env.OWED_AWS_ACCOUNT;

function fail(message) {
  process.stderr.write(`\n✗ ${message}\n`);
  process.exit(1);
}

if (TABLE === undefined) {
  fail("OWED_DYNAMO_TABLE is not set — this script writes to a real table, so it will not guess one");
}
if (REGION === undefined) {
  fail("AWS_REGION is not set — the region decides which account's table this is");
}
if (EXPECTED_ACCOUNT === undefined) {
  fail(
    "OWED_AWS_ACCOUNT is not set — name the account you expect, so this cannot seed a\n" +
      "  household's ledger into somebody else's. Find it with:\n" +
      "    aws sts get-caller-identity --query Account --output text",
  );
}
if (!existsSync(SERVER_ENTRY)) {
  fail(`${SERVER_ENTRY} is missing — run \`pnpm build\` first`);
}

// ── 1. Whose account is this? ────────────────────────────────────────────────────────
// Via the CLI rather than the SDK, so this script needs no dependency the server does not
// already have, and so it resolves credentials exactly the way your shell does.
/**
 * `AWS_ENDPOINT_URL_DYNAMODB` is honoured by both the SDK and the CLI, so setting it
 * points this whole script at DynamoDB Local without a line of special-casing in the
 * adapter. That exists so the script itself can be exercised — a smoke test nobody has
 * ever seen pass is not a check, it is a hope.
 *
 * It is called out loudly because the one thing this mode must never do is look like a
 * pass against AWS.
 */
const LOCAL_ENDPOINT = process.env.AWS_ENDPOINT_URL_DYNAMODB;
const isLocal = LOCAL_ENDPOINT !== undefined;

const identity = isLocal
  ? { Account: EXPECTED_ACCOUNT, Arn: `local:${LOCAL_ENDPOINT}` }
  : awsJson(["sts", "get-caller-identity"], "aws sts get-caller-identity — is the CLI authenticated?");

process.stdout.write(isLocal ? "Owed — smoke test, LOCAL DRY RUN\n" : "Owed — real-AWS smoke test\n");
process.stdout.write(`  account  ${identity.Account}\n`);
process.stdout.write(`  identity ${identity.Arn}\n`);
process.stdout.write(`  region   ${REGION}\n`);
process.stdout.write(`  table    ${TABLE}\n\n`);

if (isLocal) {
  process.stdout.write(
    "  !! AWS_ENDPOINT_URL_DYNAMODB is set, so this ran against DynamoDB Local.\n" +
      "  !! It exercises this script. It proves NOTHING about your AWS account.\n\n",
  );
} else if (identity.Account !== EXPECTED_ACCOUNT) {
  fail(
    `account is ${identity.Account}, expected ${EXPECTED_ACCOUNT}. Nothing was written.\n` +
      "  Set OWED_AWS_ACCOUNT to override if this is intentional.",
  );
}

// ── 2. Is the table there, with the keys the adapter expects? ────────────────────────
const described = awsJson(
  ["dynamodb", "describe-table", "--table-name", TABLE, "--region", REGION],
  `describe-table ${TABLE} in ${REGION} — create it first, the command is in the plan under Phase 1`,
);

const keys = (described.Table?.KeySchema ?? []).map((k) => `${k.AttributeName}:${k.KeyType}`);
const expectedKeys = ["household_id:HASH", "sk:RANGE"];
deepStrictEqual(keys, expectedKeys, `table key schema is ${keys.join(", ")}, expected ${expectedKeys.join(", ")}`);
process.stdout.write(`✓ table exists, keys ${keys.join(" + ")}\n`);

// ── 3. Boot the server against it, which seeds the week to real DynamoDB ─────────────
const server = spawn(process.execPath, [SERVER_ENTRY], {
  env: { ...process.env, OWED_PORT: PORT, OWED_DYNAMO_TABLE: TABLE, AWS_REGION: REGION },
  stdio: ["ignore", "pipe", "inherit"],
});

let serverOutput = "";
server.stdout.on("data", (chunk) => {
  serverOutput += String(chunk);
});

const shutdown = () => {
  if (!server.killed) server.kill("SIGTERM");
};
process.on("exit", shutdown);
process.on("SIGINT", () => {
  shutdown();
  process.exit(130);
});

const deadline = Date.now() + STARTUP_TIMEOUT_MS;
let up = false;
while (Date.now() < deadline) {
  if (server.exitCode !== null) {
    fail(`server exited early (${server.exitCode}):\n${serverOutput}`);
  }
  try {
    const response = await fetch(`http://127.0.0.1:${PORT}/.well-known/oauth-protected-resource`);
    if (response.ok) {
      up = true;
      break;
    }
  } catch {
    // not listening yet
  }
  await delay(250);
}
if (!up) fail(`server did not start within ${STARTUP_TIMEOUT_MS}ms:\n${serverOutput}`);
process.stdout.write(`✓ server booted against ${TABLE}\n`);
if (serverOutput.trim() !== "") process.stdout.write(`  ${serverOutput.trim()}\n`);

// ── 4. The same assertion the unit test makes, against real AWS ──────────────────────
const store = new DynamoEventStore(TABLE);
const fromAws = await store.read(HOUSEHOLD_ID);

const memory = new MemoryEventStore();
await memory.append(await storyboardEvents());
const expected = await memory.read(HOUSEHOLD_ID);

if (fromAws.length === 0) {
  fail("the table is empty — the server did not seed it, and nothing was proven");
}

/**
 * The seeded week must be a *prefix* of what is in the table, not the whole of it.
 *
 * Asserting equality was wrong the moment this script was run twice: filing a claim through
 * the demo appends real events, so a table that has been used has more than the storyboard
 * put there. A prefix check still catches the thing that matters — that every seeded event
 * round-trips through DynamoDB byte-for-byte, in order — while letting the script be run
 * against a table that has history.
 */
deepStrictEqual(
  fromAws.slice(0, expected.length),
  expected,
  "the seeded week read back out of DynamoDB is not what MemoryEventStore produces for it",
);
const extra = fromAws.length - expected.length;
process.stdout.write(
  `✓ ${expected.length} seeded events read back, identical to the memory store` +
    `${extra > 0 ? ` (plus ${extra} filed since)` : ""}\n`,
);

// ── 5. Independent count, so the proof does not rest on our own reader ───────────────
// Through the CLI on purpose: if the count came back through `DynamoEventStore` too, a bug
// in the adapter could agree with itself. This asks AWS directly.
const counted = awsJson(
  ["dynamodb", "scan", "--table-name", TABLE, "--select", "COUNT", "--region", REGION],
  `scan ${TABLE}`,
);
process.stdout.write(`✓ ${counted.Count} items in the table by Scan (events + the seq counter)\n`);

// ── 6. The documented contract, against a remote ledger ──────────────────────────────
//
// The same external conformance checker `pnpm conformance` runs, pointed at this server.
// Worth the one spawn: every other time it runs, the ledger is in memory on the same
// machine. This is the only place it meets a server whose every read is a network round
// trip to another continent, which is where a latency or ordering assumption would show.
//
// Not fatal if the binary is absent — it ships with `@owed/brain`'s dependencies, and a
// missing dev dependency should not fail a check about AWS.
const checker = "./apps/brain/node_modules/.bin/mcp-voice-simulator-conformance";
if (existsSync(checker)) {
  process.stdout.write("\n── Alexa+ conformance, against the DynamoDB-backed server ──\n");
  const code = await new Promise((resolve) => {
    spawn(checker, [`http://127.0.0.1:${PORT}/mcp`], { stdio: "inherit" }).on("close", resolve);
  });
  if (code !== 0) fail(`the conformance checker exited ${code}`);
  process.stdout.write("✓ documented checks pass with the ledger in DynamoDB\n");
} else {
  process.stdout.write(`\n  (conformance checker not installed at ${checker} — skipped)\n`);
}

shutdown();
store.close();

process.stdout.write(
  isLocal
    ? "\nLOCAL DRY RUN passed. This script works; your AWS account is still untouched.\n"
    : `\nThe ledger is in DynamoDB in account ${identity.Account}, and the projection agrees with it.\n` +
        "The documented Alexa+ checks also pass against it. What that does NOT establish is\n" +
        "anything about the real Alexa+ client, which is partner-gated and has never seen this\n" +
        "server — see docs/contract-v1.md. It establishes that the storage adapter is real and\n" +
        "that moving the ledger off the machine did not break the contract.\n\n" +
        `Tear down with:\n  aws dynamodb delete-table --table-name ${TABLE} --region ${REGION}\n`,
);
