#!/usr/bin/env node
/**
 * Can this machine run Owed?
 *
 * Written for somebody who has just cloned the repository and has no interest in
 * debugging it. Every check says what it looked for, what it found, and what to do
 * about it — and the ones that are not required for the demo say so, so nobody goes
 * hunting for Chrome before they have seen anything work.
 */
import { execSync } from "node:child_process";
import { createServer } from "node:net";
import { readFileSync } from "node:fs";

const results = [];
const record = (name, ok, detail, fix) => results.push({ name, ok, detail, fix });

function version(command) {
  try {
    return execSync(command, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return undefined;
  }
}

// --- required ---------------------------------------------------------------

// 24, not 20, and the reason is a hard one: the ledger's SQLite adapter imports
// `node:sqlite` at module top level (packages/mcp-server/src/store/sqlite.ts), and
// packages/mcp-server/src/main.ts imports that adapter unconditionally. The module does
// not exist before Node 22.5 and is not available unflagged before 23.4, so on Node 20
// `pnpm demo` dies with ERR_UNKNOWN_BUILTIN_MODULE before it prints anything.
//
// This check said `>= 20` and therefore cleared a configuration that cannot work — the
// one failure mode this script exists to prevent. 24 rather than 23.4 because 23 is an
// odd-numbered release and already end-of-life; pointing anyone at it would be a worse
// answer than pointing them at 24.
const nodeMajor = Number(process.versions.node.split(".")[0]);
record(
  "Node",
  nodeMajor >= 24,
  `v${process.versions.node}`,
  "Owed needs Node 24 or newer: the ledger's SQLite adapter imports `node:sqlite`, which " +
    "does not exist before 22.5 and needs a flag before 23.4. The repo is pinned to 26 in " +
    ".nvmrc; `nvm use` picks it up.",
);

const pnpmVersion = version("pnpm --version");
record(
  "pnpm",
  pnpmVersion !== undefined,
  pnpmVersion ?? "not found",
  // Not `corepack enable pnpm`: corepack was removed from Node, and this repo pins 26 in
  // .nvmrc — so the fix this line used to suggest fails on the very version it tells you
  // to use. See docs/product-feedback.md.
  "Install it with `npm install -g pnpm@10.18.2`, or see https://pnpm.io/installation.",
);

let installed = false;
try {
  readFileSync(new URL("../node_modules/.modules.yaml", import.meta.url));
  installed = true;
} catch {
  installed = false;
}
record("Dependencies", installed, installed ? "installed" : "not installed", "Run `pnpm install`.");

// All three, not just one. Each view is a separate vite pass, so a build that produced the
// ledger and then failed on the claim would have passed a check that looked at the ledger
// alone — and the failure would have surfaced much later, as a card that would not render.
const VIEWS = ["ledger", "claim", "evidence"];
const missing = VIEWS.filter((view) => {
  try {
    readFileSync(new URL(`../packages/ui-views/dist/views/${view}/index.html`, import.meta.url));
    return false;
  } catch {
    return true;
  }
});
record(
  "Built views",
  missing.length === 0,
  missing.length === 0 ? `all three ui:// views bundled` : `missing: ${missing.join(", ")}`,
  "Run `pnpm build`. The views are single-file HTML bundles and the server serves them from disk.",
);

// --- ports ------------------------------------------------------------------

const PORTS = [
  [3939, "MCP server"],
  [3940, "brain"],
  [3941, "merchant agents"],
  [5173, "simulated home"],
];

const free = (port) =>
  new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen(port, "127.0.0.1");
  });

for (const [port, what] of PORTS) {
  const open = await free(port);
  record(
    `Port ${port}`,
    open,
    open ? `free (${what})` : `in use — ${what} cannot start`,
    `Something else is listening on ${port}. Stopping it is the simple fix. Moving the port is not just OWED_PORT: the brain finds the server through OWED_MCP_URL, so both have to agree — and set them for the one command rather than exporting them, because conformance and aws:smoke read OWED_PORT too and pick 3999/3998 to stay out of the way.`,
  );
}

// --- optional ---------------------------------------------------------------

const chrome = version("node -e \"import('playwright-core').then(p => process.stdout.write(p.chromium.executablePath({channel:'chrome'})))\"");
record(
  "Chrome (optional)",
  chrome !== undefined && chrome.length > 0,
  chrome && chrome.length > 0 ? "found" : "not found",
  "Only needed for `pnpm verify:ui`, which drives the cards in a real browser. The demo and `pnpm verify` do not use it.",
  );

// --- report -----------------------------------------------------------------

const required = results.filter((r) => !r.name.includes("optional"));
const failed = required.filter((r) => !r.ok);

process.stdout.write("\nOwed preflight\n\n");
for (const result of results) {
  const mark = result.ok ? "ok  " : result.name.includes("optional") ? "--  " : "FAIL";
  process.stdout.write(`  ${mark} ${result.name.padEnd(20)} ${result.detail}\n`);
  if (!result.ok) process.stdout.write(`       ${result.fix}\n`);
}

if (failed.length === 0) {
  process.stdout.write(`
  Everything needed is here. Next:

    pnpm demo      then open http://127.0.0.1:5173 and ask "what am I owed?"
    pnpm verify    build, lint, the whole test suite and the conformance check
    pnpm verify:ui the same storyboard, driven in a real browser

`);
  process.exit(0);
}

process.stdout.write(
  `\n  ${failed.length === 1 ? "One thing" : `${failed.length} things`} to fix before the demo will run.\n\n`,
);
process.exit(1);
