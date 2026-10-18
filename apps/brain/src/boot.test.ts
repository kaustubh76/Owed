import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The boot retry, driven as a process — which is the only place it ever failed.
 *
 * `main.ts` says it makes forty attempts at the MCP server and then exits for systemd to
 * retry. It made **one**. `ensure()` created its reconnect backoff with `.unref()`, copied
 * from the renewal timer where that is correct and necessary; but the brain deliberately
 * binds no port until it has a live session, so while it was backing off that timer was the
 * only pending work in the process. Node drained the event loop and exited 13 — "Detected
 * unsettled top-level await at main.js:107" — after the first failure.
 *
 * `pnpm demo` starts all four processes at once through `concurrently`, so the MCP server is
 * usually still booting when the brain first tries. The command the README leads with
 * therefore left the home reading **brain offline**, and nothing in `pnpm verify` noticed.
 * `scripts/verify-ui.mjs` did not notice either, for a reason worth keeping: it waits for the
 * server to answer *before* it starts the brain, so the first attempt always succeeded and the
 * backoff was never armed.
 *
 * **No unit test can catch this.** Vitest keeps its own event loop alive, so an unref'd timer
 * still fires under the runner, and `session.test.ts`'s "does not cache a failed attempt" —
 * which drives exactly this path, twice — passes with the bug present and with it fixed. The
 * defect exists only where nothing else is pending. That makes a subprocess the test, not a
 * stylistic preference.
 *
 * Runs against `dist/`, like the tests that already resolve `@owed/mcp-server` that way.
 * `pnpm verify` builds before it tests, and so does CI.
 */

const MAIN = fileURLToPath(new URL("../dist/main.js", import.meta.url));

/** Nothing listens here, so every attempt fails the way a cold `pnpm demo` fails. */
const NOWHERE = "http://127.0.0.1:59999/mcp";

/** Long enough for the 500 ms sleep and the 500 ms backoff that follow the first failure. */
const WATCH_MS = 3_000;

async function bootAgainstNothing(): Promise<{ output: string; exitCode: number | null }> {
  if (!existsSync(MAIN)) {
    throw new Error(
      `${MAIN} is missing. Run \`pnpm build\` — the brain is exercised as a process here, ` +
        "because the failure this guards against only happens when nothing else is keeping " +
        "the event loop alive.",
    );
  }

  const child = spawn(process.execPath, [MAIN], {
    env: { ...process.env, OWED_MCP_URL: NOWHERE },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const state = { output: "", exitCode: null as number | null };
  child.stdout.on("data", (chunk) => {
    state.output += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    state.output += String(chunk);
  });
  child.on("exit", (code) => {
    state.exitCode = code;
  });

  await new Promise((resolve) => setTimeout(resolve, WATCH_MS));
  if (state.exitCode === null) child.kill("SIGTERM");
  return state;
}

describe("the brain coming up before the server does", () => {
  it("keeps retrying rather than exiting after one attempt", async () => {
    const { output, exitCode } = await bootAgainstNothing();
    const attempts = output.split("\n").filter((line) => line.includes("waiting for"));

    // The symptom, named so a future failure is recognisable rather than mysterious.
    expect(output, "the process died on an unsettled await").not.toMatch(
      /unsettled top-level await/,
    );
    expect(exitCode, `the brain exited instead of waiting:\n${output}`).toBeNull();
    expect(attempts.length, `only ${attempts.length} attempt(s):\n${output}`).toBeGreaterThan(1);
  });
});
