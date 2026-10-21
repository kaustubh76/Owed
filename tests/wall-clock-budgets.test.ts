import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * A test that waits on a wall clock has two budgets, and only the smaller one is real.
 *
 * `apps/brain/src/boot.test.ts` declared `DEADLINE_MS = 20_000`, polled to it, and explained
 * at length why twenty seconds was the right window for a cold Node subprocess competing with
 * the rest of the suite. It never got twenty seconds. The `it` passed no `timeout`, and
 * `vitest.config.ts` sets no global `testTimeout`, so vitest killed it at its default 5 000 ms
 * — fifteen seconds of budget the file believed it had and the runner never granted. One red
 * run in twelve, `Test timed out in 5000ms`, and then six green re-runs that said nothing.
 *
 * Nothing could have caught that. The two numbers live in different files, one of them is a
 * default that appears in neither, and the symptom is a flake — which is the one failure mode
 * that gets re-run rather than read. So it is asserted here, statically, over every test file
 * in the repository.
 *
 * **The rule.** A test file that drives a real wall clock — it spawns a subprocess, or it
 * declares a `*_MS` constant at or above the runner's default — must pass an explicit
 * `timeout:` somewhere, and the largest timeout it declares must cover the largest budget it
 * declares. Files that do neither are left alone: a unit test is not improved by naming a
 * ceiling it will never approach.
 *
 * The rule is deliberately about the hazard rather than about arithmetic. It does not try to
 * understand `await sleep(n)` in a loop, and a file can still defeat it by hiding a budget in
 * a computed expression. What it does cover is the shape that actually shipped broken, and it
 * fails loudly — rather than silently passing — on any `timeout:` it cannot evaluate.
 */

const THIS_FILE = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(THIS_FILE), "..");

/** Vitest's own default, used only when `vitest.config.ts` names no global of its own. */
const VITEST_DEFAULT_TIMEOUT_MS = 5_000;

/** The same helper `scripts/verify-graph.mjs` uses, and for the same reason: three separate
 * checks in this repo have tripped on a comment *about* code rather than on the code. */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join("\n");
}

function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Every `*.test.ts` under a directory, without pulling in a glob dependency. */
function testFiles(dir: string, found: string[] = []): string[] {
  if (!exists(dir)) return found;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) testFiles(path, found);
    else if (entry.name.endsWith(".test.ts")) found.push(path);
  }
  return found;
}

const asNumber = (literal: string): number => Number(literal.replace(/_/g, ""));

/**
 * Sum a `timeout:` expression, or return null if any term is not a number this can see.
 *
 * `null` is a failure, never a pass — a ceiling nobody can evaluate is exactly the state this
 * file exists to refuse. Covers the three shapes the repo uses: a literal (`120_000`), a
 * constant (`CONTAINER_IO_TIMEOUT_MS`), and a sum (`DEADLINE_MS + GRACE_MS`).
 */
function resolveMs(expression: string, constants: Map<string, number>): number | null {
  let total = 0;
  for (const term of expression.split("+")) {
    const text = term.trim();
    if (/^[0-9][0-9_]*$/.test(text)) {
      total += asNumber(text);
      continue;
    }
    const known = constants.get(text);
    if (known === undefined) return null;
    total += known;
  }
  return total;
}

const config = withoutComments(readFileSync(join(REPO_ROOT, "vitest.config.ts"), "utf8"));
const globalTimeout = /(?:^|[^A-Za-z])testTimeout:\s*([0-9][0-9_]*)/.exec(config);
const DEFAULT_MS = globalTimeout === null ? VITEST_DEFAULT_TIMEOUT_MS : asNumber(globalTimeout[1]);

type Reading = {
  file: string;
  spawns: boolean;
  budget: number;
  ceiling: number | null;
  unresolvable: string[];
};

function read(absolute: string): Reading {
  const source = withoutComments(readFileSync(absolute, "utf8"));

  const constants = new Map<string, number>();
  for (const [, name, literal] of source.matchAll(
    /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*([0-9][0-9_]*)\s*;/g,
  )) {
    constants.set(name, asNumber(literal));
  }

  const budgets = [...source.matchAll(/\bconst\s+([A-Z][A-Z0-9_]*_MS)\s*=\s*([0-9][0-9_]*)/g)].map(
    ([, , literal]) => asNumber(literal),
  );

  const ceilings: number[] = [];
  const unresolvable: string[] = [];
  // `(?:^|[^A-Za-z])` so `testTimeout:` in a config-shaped literal is not mistaken for one.
  for (const [, expression] of source.matchAll(/(?:^|[^A-Za-z])timeout:\s*([^,\n}]+)/g)) {
    const value = resolveMs(expression, constants);
    if (value === null) unresolvable.push(expression.trim());
    else ceilings.push(value);
  }

  return {
    file: relative(REPO_ROOT, absolute),
    spawns: /\bspawn\(/.test(source),
    budget: budgets.length === 0 ? 0 : Math.max(...budgets),
    ceiling: ceilings.length === 0 ? null : Math.max(...ceilings),
    unresolvable,
  };
}

/**
 * Every test file but this one.
 *
 * A check that reads source necessarily contains the patterns it searches for, and this one
 * failed all three of its own assertions on the first run for exactly that reason: it declares
 * `VITEST_DEFAULT_TIMEOUT_MS` (a `*_MS` constant, so it looked like a budget), and the strings
 * it builds to *report* a bad ceiling contain the word it greps for. The skip is explicit
 * rather than a quiet filter, because the alternative — loosening the patterns until the file
 * stops matching itself — would loosen them for every other file too.
 */
const scanned = ["packages", "apps", "eval", "tests"]
  .flatMap((dir) => testFiles(join(REPO_ROOT, dir)))
  .filter((absolute) => absolute !== THIS_FILE)
  .map(read);

/** The files the rule applies to: they spawn, or they name a budget the default cannot cover. */
const wallClock = scanned.filter((one) => one.spawns || one.budget >= DEFAULT_MS);

describe("a wall-clock test's two budgets", () => {
  it("declares the ceiling the runner will actually enforce", () => {
    const wrong = wallClock
      .filter((one) => one.ceiling === null || one.ceiling < one.budget)
      .map((one) =>
        one.ceiling === null
          ? `${one.file}: waits on a wall clock (${one.spawns ? "spawns a subprocess" : `declares ${one.budget} ms`}) ` +
            `but passes no \`timeout:\`, so the runner stops it at ${DEFAULT_MS} ms`
          : `${one.file}: declares ${one.budget} ms but its largest \`timeout:\` is ${one.ceiling} ms`,
      );

    expect(wrong, "a declared deadline the runner will not allow the test to reach").toStrictEqual(
      [],
    );
  });

  it("and every ceiling it declares can be evaluated", () => {
    const opaque = scanned
      .filter((one) => one.unresolvable.length > 0)
      .map((one) => `${one.file}: cannot evaluate \`timeout: ${one.unresolvable.join(", ")}\``);

    // Not a pass by default: an unreadable ceiling is the state this file exists to refuse.
    expect(
      opaque,
      "a `timeout:` this check cannot read is not a `timeout:` it has verified",
    ).toStrictEqual([]);
  });

  /**
   * The vacuity guard. This repo's own recurring failure is a check that passes because it is
   * looking at nothing — a CSP assertion over an empty list, a chips check over an empty set.
   * Both halves matter: the walker has to find the suite, and the filter has to keep the files
   * that provoked the rule.
   */
  it("is looking at the suite, and at the files that needed the rule", () => {
    expect(scanned.length, "test files found by the walker").toBeGreaterThan(40);

    const spawning = scanned.filter((one) => one.spawns).map((one) => one.file);
    expect(spawning, "test files that spawn a subprocess").not.toStrictEqual([]);
    expect(
      spawning.filter((file) => !wallClock.some((one) => one.file === file)),
      "spawns a subprocess but the rule skipped it",
    ).toStrictEqual([]);

    expect(wallClock.map((one) => one.file).sort(), "the files the rule applies to").toStrictEqual([
      "apps/brain/src/boot.test.ts",
      "packages/mcp-server/src/store/dynamo.test.ts",
    ]);
  });
});
