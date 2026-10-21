#!/usr/bin/env node
/**
 * Boot the server and run the community conformance checker against it.
 *
 * The same four assertions are covered by unit tests in `auth.test.ts`, but running
 * the real CLI is what proves the server satisfies the tool a judge would reach for,
 * rather than our reading of it.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

const PORT = process.env.OWED_PORT ?? "3999";
const MCP_URL = `http://127.0.0.1:${PORT}/mcp`;
const STARTUP_TIMEOUT_MS = 20_000;

const server = spawn(process.execPath, ["packages/mcp-server/dist/main.js"], {
  env: { ...process.env, OWED_PORT: PORT },
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

async function waitForServer() {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(`server exited early (${server.exitCode}):\n${serverOutput}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/.well-known/oauth-protected-resource`);
      if (response.ok) return;
    } catch {
      // not listening yet
    }
    await delay(250);
  }
  throw new Error(`server did not start within ${STARTUP_TIMEOUT_MS}ms:\n${serverOutput}`);
}

await waitForServer();

/**
 * Guarded, because this is in `pnpm verify` and the failure was an uncaught exception.
 *
 * `spawn` of a missing binary emits `'error'`, and with no listener that is an unhandled
 * event — a stack trace, not the tidy `exit(code ?? 1)` below. The checker ships with
 * `@owed/brain`'s dependencies rather than the root's, reached by this hand-written path, so
 * "not installed" is a reachable state: a tree where `apps/brain` was not installed, a
 * different pnpm hoisting, or simply running this from the wrong directory.
 *
 * `scripts/aws-smoke.mjs` has had the guard for the same path for weeks, two hundred lines
 * away, with the reasoning written out — and it *skips*, because a missing dev dependency
 * should not fail a check about AWS. Here it must fail, because conformance is the check,
 * but it should say so rather than crash. `verify:graph` could never have caught this: it
 * only reads `@owed` imports under each package's own `src`, so a root `.mjs` reaching into
 * another workspace member's installed dependencies is outside its remit by construction.
 */
const CHECKER = "./apps/brain/node_modules/.bin/mcp-voice-simulator-conformance";
if (!existsSync(CHECKER)) {
  shutdown();
  process.stderr.write(
    `\n✗ the conformance checker is not installed at ${CHECKER}\n\n` +
      "  It is a dependency of `apps/brain`, not of the root, so `pnpm install` at the\n" +
      "  workspace root is what provides it. Run this from the repository root.\n",
  );
  process.exit(1);
}

const checker = spawn(CHECKER, [MCP_URL], { stdio: "inherit" });
checker.on("error", (cause) => {
  shutdown();
  process.stderr.write(`\n✗ could not run the conformance checker: ${cause.message}\n`);
  process.exit(1);
});

const code = await new Promise((resolve) => checker.on("close", resolve));

if (code === 0) {
  // The checker's closing line points at a document inside its own package, which sends
  // anyone reading this output hunting through Owed's docs/ for a file that was never
  // here. Owed's equivalent is named below.
  process.stdout.write(
    "\nThat last line is the conformance CLI's own, and the file it names lives in that\n" +
      "package. Owed's account of what this does and does not establish — including that\n" +
      "none of it has run against the real Alexa+ client — is docs/contract-v1.md.\n",
  );
}

shutdown();
process.exit(code ?? 1);
