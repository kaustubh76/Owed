import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Nothing in this repository is exported and called by nobody.
 *
 * "Wire dead code, never delete it" is this project's standing rule, and `verify:graph` enforces
 * the package-level half of it: a package that declares `@owed/x` and never imports it fails.
 * The symbol-level half — a function or constant exported and referenced nowhere — had never been
 * checked, and on 2026-10-22 a sweep put it at **zero** across 380 exported values in 128 product
 * files. That is a measurement of one afternoon; this is the same sweep, run on every push.
 *
 * **The shape of the check is three mistakes I made first, each worth keeping as a reason.**
 *
 * *It counts values, not types.* Including `type` and `interface` declarations reported 190
 * offenders, nearly all of them nonsense: an interface that names a local function's parameter is
 * not dead code. Values are the things that either run or do not.
 *
 * *It counts the declaring file.* The first pass excluded it, which is how `nextAction` — the
 * heart of the negotiator, wired at `negotiator.ts:218` into `createNegotiator` and driven by
 * `filing.ts` — came back looking orphaned. A symbol used once in its own file is live code; the
 * export may be wider than it needs to be, which is a different and much smaller complaint.
 *
 * *Tests and gate scripts count as references.* `packages/domain/src/money.test.ts` sets out the
 * case this repository had already decided: where a symbol genuinely has no honest call site — a
 * published package's type surface, or a quantity named so it can be reasoned about —
 * "guarantee it with a test and say why no call site belongs". Twelve symbols are in exactly that
 * position, `ensureDynamoTable` and `meanRealisedWhenCountered` among them, each with the reason
 * written beside it. Failing them would be arguing with a decision this project made on purpose.
 *
 * So what is left to fail is the real thing: an export nobody anywhere mentions. The message says
 * what the two honest answers are, because a check that only says "no" sends people to delete.
 */

const THIS_FILE = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(THIS_FILE), "..");

/** Where the product lives, and where a reference to it may legitimately come from. */
const PRODUCT_DIRS = ["packages", "apps", "eval"];
const GATE_SCRIPTS = join(REPO_ROOT, "scripts");

function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Every `.ts`/`.tsx` under a directory, without pulling in a glob dependency. */
function typescriptIn(dir: string, found: string[] = []): string[] {
  if (!exists(dir)) return found;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) typescriptIn(path, found);
    else if (/\.tsx?$/.test(entry.name)) found.push(path);
  }
  return found;
}

const isTest = (path: string) => /\.test\.tsx?$/.test(path);

/**
 * Comments stripped before anything is counted — the house helper, and the house lesson.
 *
 * This repository has been caught by prose-about-code three times: a readme search matched the
 * sentence explaining an evidence kind, an unused-dependency check matched the doc comment naming
 * the dependency, and a Bedrock check tripped on a script's own comment saying it grants no
 * Bedrock permission. A symbol named in a doc comment is not a caller, and this file is full of
 * doc comments naming symbols, so counting them would be the same mistake a fourth time.
 */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join("\n");
}

const everything = PRODUCT_DIRS.flatMap((dir) => typescriptIn(join(REPO_ROOT, dir)));
const product = everything.filter((path) => !isTest(path));
const referencing = [
  ...everything.filter(isTest),
  ...typescriptIn(join(REPO_ROOT, "tests")),
  ...(exists(GATE_SCRIPTS)
    ? readdirSync(GATE_SCRIPTS)
        .filter((name) => name.endsWith(".mjs"))
        .map((name) => join(GATE_SCRIPTS, name))
    : []),
].filter((path) => path !== THIS_FILE);

/** `function`, `const`, `class` — the three that are code rather than a name for a shape. */
const EXPORTED_VALUE = /^export\s+(?:async\s+)?(?:function|const|class)\s+([A-Za-z_$][\w$]*)/gm;

const productText = new Map(
  product.map((path) => [path, withoutComments(readFileSync(path, "utf8"))]),
);
const elsewhere = referencing.map((path) => withoutComments(readFileSync(path, "utf8"))).join("\n");

/** The declarations are read from the stripped text too, so a commented-out export is not one. */

const unwired: string[] = [];
const scanned: string[] = [];

for (const [path, body] of productText) {
  for (const [, name] of body.matchAll(EXPORTED_VALUE)) {
    scanned.push(name);

    // Whole-token, so `usd` does not match `usdMinor` and `atDate` does not match `atDateTime`.
    const token = new RegExp(`(?<![\\w$])${name.replace(/[$]/g, "\\$&")}(?![\\w$])`, "g");
    const count = (text: string) => (text.match(token) ?? []).length;

    // Its own file first and minus the declaration, then the rest, then tests and gates. Stops
    // at the first reference it finds: the question is whether there is one, not how many.
    let references = count(body) - 1;
    if (references === 0) {
      for (const [other, text] of productText) {
        if (other === path) continue;
        references += count(text);
        if (references > 0) break;
      }
    }
    if (references === 0) references += count(elsewhere);

    if (references === 0) unwired.push(`${name} (${relative(REPO_ROOT, path)})`);
  }
}

describe("every export has a caller", () => {
  it("finds nothing exported and referenced nowhere at all", () => {
    expect(
      unwired.sort(),
      "exported and mentioned by nothing — wire it to the call site it was written for, or, if" +
        " it genuinely has none, guarantee it with a test that says why (see" +
        " packages/domain/src/money.test.ts)",
    ).toStrictEqual([]);
  });

  /**
   * The vacuity guard, in both directions.
   *
   * A walker that finds no files reports no problems, which this repository has shipped twice.
   * And a token matcher that silently fails to resolve anything would report the same — so three
   * symbols are named as a positive control: one wired through a callback, one used only by
   * tests, and one called all over the server.
   */
  it("is looking at the whole product, and its matcher resolves", () => {
    expect(product.length, "product files walked").toBeGreaterThan(120);
    expect(scanned.length, "exported values found").toBeGreaterThan(350);
    expect(
      referencing.length,
      "test files and gate scripts that may hold a reference",
    ).toBeGreaterThan(50);

    for (const control of ["nextAction", "maxMoney", "assertSpeakable"]) {
      expect(scanned, `${control} should be among the exports scanned`).toContain(control);
      expect(unwired.join(" "), `${control} is referenced and must not be reported`).not.toContain(
        control,
      );
    }
  });
});
