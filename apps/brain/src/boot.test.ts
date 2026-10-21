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

/**
 * Waited for rather than slept through, and the difference is a flake this shipped with.
 *
 * It used to sleep a flat 3 s and then count attempts. That budget looks generous — the
 * brain's first attempt is immediate and its backoff is 500 ms — but it was measured from
 * `spawn`, so it also had to cover Node starting and `dist/main.js` loading the MCP SDK and
 * Express. On an idle machine that is a few hundred milliseconds; under the full 583-test
 * suite it is not, and a fresh clone produced exactly one attempt inside the window and a
 * red test. The same suite passed on the next run, which is the signature.
 *
 * So the deadline is long and the wait is short: stop as soon as the thing being asserted is
 * true, and give a slow machine room before calling it a failure. Nothing about what is
 * asserted changes — the brain must not exit, and it must try more than once.
 */
const DEADLINE_MS = 20_000;
const SETTLED_ATTEMPTS = 2;

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

  const attempts = () =>
    state.output.split("\n").filter((line) => line.includes("waiting for")).length;
  const deadline = Date.now() + DEADLINE_MS;
  while (Date.now() < deadline && state.exitCode === null && attempts() < SETTLED_ATTEMPTS) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

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
