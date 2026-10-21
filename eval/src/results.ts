import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Where a harness writes its report, and the one place that decides it.
 *
 * All seven binaries used to hardcode `new URL("../../results/", import.meta.url)` and
 * then `mkdirSync` + `writeFileSync` + a `process.stdout.write` naming the path as a
 * literal string. Seven copies of four lines, with three of them subtly different —
 * `recourse.ts` computed the directory twice, `extraction.ts` wraps two reports into one
 * object, `extraction-bedrock.ts` writes a differently-named file.
 *
 * Collapsing them was not the point. The point is `OWED_EVAL_RESULTS`.
 *
 * `scripts/verify-eval.mjs` re-runs the five deterministic harnesses and insists every
 * figure in `eval/results/*.json` is still the one the code produces. With the destination
 * hardcoded, the only way to re-derive a report was to let the harness overwrite the
 * tracked file and put the original back afterwards — so the gate wrote to tracked files
 * on every run and was correct only because a `finally` block restored them. A `finally`
 * does not run on SIGINT, and that gate sits in the middle of `pnpm verify`, which is
 * exactly the command people cancel; worse, Ctrl-C signals the process group, so the
 * harness could die *inside* `writeFileSync` and leave a tracked report truncated with
 * nothing left to restore it.
 *
 * With an override the gate points the harnesses at a temp directory and never writes to
 * the repository at all. The hole closes because there is nothing to undo, which is the
 * same argument `scripts/draw-architecture.mjs --check` already makes here: a gate that
 * regenerates the file it is checking cannot fail.
 */
export const RESULTS_DIR =
  process.env.OWED_EVAL_RESULTS ?? fileURLToPath(new URL("../results/", import.meta.url));

/** True when a caller redirected the output, which changes only what is printed. */
const REDIRECTED = process.env.OWED_EVAL_RESULTS !== undefined;

/**
 * Write one report and return the path to say it went to.
 *
 * `join` rather than string concatenation, deliberately: every bin used to build its path
 * as `` `${dir}breach.json` ``, which is correct only because the hardcoded URL ended in a
 * slash. An override passed as `/tmp/x` would have written `/tmp/xbreach.json` — silently,
 * to a file nobody would look for.
 */
export function writeReport(name: string, report: unknown): string {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const path = join(RESULTS_DIR, `${name}.json`);
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
  // The repo-relative name is what a reader wants when nothing was redirected, and the
  // absolute path is the only useful thing to print when something was.
  return REDIRECTED ? path : `eval/results/${name}.json`;
}
