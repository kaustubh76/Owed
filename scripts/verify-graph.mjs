#!/usr/bin/env node
/**
 * Every cross-package import must be declared twice, and nothing was checking the second.
 *
 * A package that imports `@owed/x` needs it in `dependencies`, which pnpm enforces, and it
 * needs a `references` entry in its `tsconfig.json`, which nothing enforced. Without the
 * reference the import still resolves — through the workspace symlink to the other
 * package's `dist` — so it works whenever that `dist` happens to be there.
 *
 * `tsc -b` under TypeScript 7 builds independent projects concurrently, so whether it is
 * there is a race. `packages/mcp-server` imported `@owed/ui-views` with no reference for
 * four commits: three of them went green and the fourth failed on CI with
 * `TS2307: Cannot find module '@owed/ui-views'`, on a clean checkout, from a tree that
 * built fine on two other machines. Nothing about the code had changed.
 *
 * The tests could not have caught it either, in either direction: `vitest.config.ts`
 * aliases most `@owed/*` names straight to source, so a missing reference is invisible
 * there, and `@owed/ui-views` is deliberately left resolving to `dist`, so a test of it
 * reads the last build rather than the working tree.
 *
 * This is cheap, static, and runs before the build it protects.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const failures = [];

/** The tsconfigs here carry comments, which `JSON.parse` will not have. */
function readJsonc(path) {
  return JSON.parse(
    readFileSync(path, "utf8")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/\/\*[\s\S]*?\*\//g, ""),
  );
}

/**
 * Source with its comments removed, so prose about a package is not mistaken for using it.
 *
 * Block comments go wholesale; line comments only where the line is nothing but a comment,
 * which leaves `https://` inside a string alone.
 */
function withoutComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join("\n");
}

function exists(path) {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Every `.ts`/`.tsx` under a directory, without pulling in a glob dependency. */
function sources(dir, found = []) {
  if (!exists(dir)) return found;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sources(path, found);
    else if (/\.tsx?$/.test(entry.name)) found.push(path);
  }
  return found;
}

/** The workspace's own packages: anything with a package.json one or two levels down. */
function workspacePackages() {
  const found = [];
  for (const group of ["packages", "apps", "."]) {
    const base = join(REPO_ROOT, group);
    if (!exists(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === "node_modules") continue;
      const dir = join(base, entry.name);
      if (exists(join(dir, "package.json"))) found.push(dir);
    }
  }
  return found;
}

const byDirectory = new Map();
for (const dir of workspacePackages()) {
  const { name } = readJsonc(join(dir, "package.json"));
  if (typeof name === "string") byDirectory.set(dir, name);
}

process.stdout.write("Owed project graph\n\n");

let checked = 0;
for (const [dir, name] of [...byDirectory].sort((a, b) => a[1].localeCompare(b[1]))) {
  const tsconfigPath = join(dir, "tsconfig.json");

  // What this package's own source actually imports from the workspace.
  const imported = new Set();
  for (const file of sources(join(dir, "src"))) {
    for (const [, specifier] of readFileSync(file, "utf8").matchAll(
      /\bfrom\s+"(@owed\/[a-z0-9-]+)"/g,
    )) {
      imported.add(specifier);
    }
  }
  if (imported.size === 0) continue;
  checked += 1;

  const pkg = readJsonc(join(dir, "package.json"));
  const declared = new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
  ]);

  // The references, resolved to package names rather than compared as paths.
  const referenced = new Set();
  if (exists(tsconfigPath)) {
    for (const reference of readJsonc(tsconfigPath).references ?? []) {
      const target = resolve(dir, reference.path, "package.json");
      if (exists(target)) referenced.add(readJsonc(target).name);
    }
  }

  for (const specifier of [...imported].sort()) {
    const where = `${name} imports ${specifier}`;
    if (!declared.has(specifier)) {
      failures.push(
        `${where} without declaring it in ${relative(REPO_ROOT, join(dir, "package.json"))}`,
      );
      process.stdout.write(`  FAIL ${where} — not in dependencies\n`);
      continue;
    }
    /**
     * A package with no tsconfig is not a TypeScript project — `apps/home` is built by
     * Vite — so there is no reference for it to be missing.
     */
    if (!exists(tsconfigPath)) continue;
    if (!referenced.has(specifier)) {
      failures.push(`${where} without a tsconfig reference, so its build order depends on luck`);
      process.stdout.write(`  FAIL ${where} — no tsconfig reference\n`);
      continue;
    }
    process.stdout.write(`  ok  ${where} — declared and referenced\n`);
  }
}

/**
 * The same graph, read the other way, plus the three things it asserts and nothing checked.
 *
 * The loop above skips a package that imports nothing (`if (imported.size === 0) continue`),
 * which is exactly why an edge *declared* and never imported was invisible: two of them had
 * been sitting in `package.json` and `tsconfig.json` with no import behind them, and a dead
 * `references` entry is not merely untidy — it adds a build-order edge, which is the one thing
 * this gate exists to get right.
 */
process.stdout.write("\n--- the other direction, and the graph as a whole ---\n");

const graph = new Map();
for (const [dir, name] of byDirectory) {
  const pkg = readJsonc(join(dir, "package.json"));
  const text = sources(join(dir, "src"))
    .map((file) => withoutComments(readFileSync(file, "utf8")))
    .join("\n");
  const declaredWorkspace = new Set(
    Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })
      .filter(([key, value]) => key.startsWith("@owed/") && String(value).startsWith("workspace:"))
      .map(([key]) => key),
  );
  graph.set(name, { dir, pkg, text, declaredWorkspace });
}

for (const [name, { dir, text, declaredWorkspace }] of [...graph].sort((a, b) =>
  a[0].localeCompare(b[0]),
)) {
  for (const dep of [...declaredWorkspace].sort()) {
    /**
     * Mentioned anywhere in the *code*, not just in a `from "…"`.
     *
     * Looser than the import scan above on purpose, because `mcp-server` reaches a built view
     * through a template literal (`@owed/ui-views/${viewEntry(name)}`) and a stricter test
     * would call a real edge dead.
     *
     * Comments are stripped first, and that is not a detail: the first version of this check
     * read the raw source, so the doc comment explaining *why* a package depends on another
     * was enough to satisfy it. Removing the import and leaving the paragraph passed. Found by
     * mutation — the check could not fail for the one file whose prose named its own
     * dependency.
     */
    if (text.includes(dep)) {
      process.stdout.write(`  ok  ${name} declares ${dep} — and imports it\n`);
      continue;
    }
    failures.push(
      `${name} declares ${dep} in ${relative(REPO_ROOT, join(dir, "package.json"))} and never imports it`,
    );
    process.stdout.write(`  FAIL ${name} declares ${dep} — never imported\n`);
  }
}

/**
 * A published package may not reach a private one.
 *
 * This is `readme.md` §15's Open Source paragraph in one line: `recourse-protocol`,
 * `policy-library` and `merchant-agents` can be lifted out as they stand, while `extractor`
 * and `extractor-bedrock` cannot, because both reach `@owed/domain`, which is `private: true`.
 * The claim is true today and the obvious future edit — adding `@owed/domain` to
 * `policy-library`, which is a natural thing to want — breaks it with nothing complaining.
 */
const isPrivate = (name) => graph.get(name)?.pkg.private === true;

function reachesPrivate(start) {
  const seen = new Set([start]);
  const queue = [[start]];
  while (queue.length > 0) {
    const path = queue.shift();
    const last = path[path.length - 1];
    for (const dep of graph.get(last)?.declaredWorkspace ?? []) {
      if (!graph.has(dep)) continue;
      const next = [...path, dep];
      if (isPrivate(dep)) return next;
      if (seen.has(dep)) continue;
      seen.add(dep);
      queue.push(next);
    }
  }
  return undefined;
}

/**
 * What `readme.md` §15 claims, pinned in both directions.
 *
 * Failing on any publishable-reaches-private edge was my first attempt and it was wrong: it
 * reported `extractor` and `extractor-bedrock` as violations when the readme already says, in
 * as many words, that both "cannot be lifted out without extracting the domain types first".
 * An acknowledged limitation is not a defect.
 *
 * So the lists below are the claim. Three packages lift out as they stand and must reach
 * nothing private; two are blocked and must still be blocked — if one ever becomes liftable
 * the readme understates what is on offer, which is worth being told about. A new publishable
 * package belongs in one list or the other, so adding one forces the decision rather than
 * quietly inheriting either answer.
 */
const LIFTS_OUT = ["@owed/merchant-agents", "@owed/policy-library", "@owed/recourse-protocol"];
const BLOCKED_BY_PRIVATE = ["@owed/extractor", "@owed/extractor-bedrock"];

for (const [name] of [...graph].sort((a, b) => a[0].localeCompare(b[0]))) {
  if (isPrivate(name)) continue;

  const chain = reachesPrivate(name);
  const expectation = LIFTS_OUT.includes(name)
    ? "lifts out"
    : BLOCKED_BY_PRIVATE.includes(name)
      ? "blocked"
      : undefined;

  if (expectation === undefined) {
    failures.push(
      `${name} is publishable and readme.md §15 does not say whether it lifts out — add it to LIFTS_OUT or BLOCKED_BY_PRIVATE in this script, and to §15`,
    );
    process.stdout.write(`  FAIL ${name} is publishable and unaccounted for in §15\n`);
    continue;
  }

  if (expectation === "lifts out") {
    if (chain === undefined) {
      process.stdout.write(`  ok  ${name} lifts out — reaches nothing private\n`);
    } else {
      failures.push(
        `${name} is claimed to lift out but reaches the private ${chain[chain.length - 1]} — ${chain.join(" -> ")}`,
      );
      process.stdout.write(`  FAIL ${name} no longer lifts out — ${chain.join(" -> ")}\n`);
    }
    continue;
  }

  if (chain === undefined) {
    failures.push(
      `${name} is listed as blocked by a private package and no longer reaches one — it lifts out now, so readme.md §15 understates what is publishable`,
    );
    process.stdout.write(`  FAIL ${name} is no longer blocked — §15 understates it\n`);
  } else {
    process.stdout.write(`  ok  ${name} is blocked as §15 says — ${chain.join(" -> ")}\n`);
  }
}

/** The packaging half of the same claim, equally checkable. */
for (const [name, { dir, pkg }] of [...graph].sort((a, b) => a[0].localeCompare(b[0]))) {
  if (pkg.private === true) continue;
  const missing = [
    pkg.license === undefined ? "license" : undefined,
    pkg.files === undefined ? "files" : undefined,
    pkg.exports === undefined ? "exports" : undefined,
    exists(join(dir, "README.md")) ? undefined : "README.md",
  ].filter((entry) => entry !== undefined);

  if (missing.length === 0) {
    process.stdout.write(`  ok  ${name} ships as a package — license, files, exports, README\n`);
    continue;
  }
  failures.push(`${name} is publishable but has no ${missing.join(", ")}`);
  process.stdout.write(`  FAIL ${name} is publishable but has no ${missing.join(", ")}\n`);
}

/**
 * And the licence it declares is actually in the package.
 *
 * The block above checks `pkg.license !== undefined` — a *string in `package.json`* — under a
 * comment calling itself the packaging half of the claim. Three of its four checks are
 * declarations, and the file it does look for is the one that was there. So all five
 * publishable packages passed it while shipping **no copy of the licence at all**: `LICENSE`
 * and `NOTICE` existed only at the repository root, and npm's always-included set covers
 * `LICENSE*` from *the package's own* directory and does not cover `NOTICE` in any directory.
 *
 * That matters because this repository invites the distribution. `NOTICE` says these packages
 * "are licensed under it for use outside this repository", and readme §15 says three of them
 * lift out as they stand — while Apache-2.0 §4(a) requires the licence to accompany every
 * distribution of the work and §4(d) requires a redistribution to carry the NOTICE's
 * attribution notices.
 *
 * Byte-identity is checked rather than mere presence, because the fix is five copies of an
 * 11 KB text and five copies are five things that can drift. Same treatment
 * `policy-library`'s duplicated breach kinds get from a test: the duplication is allowed and
 * then held in step.
 */
const LEGAL = ["LICENSE", "NOTICE"];
const rootLegal = new Map(LEGAL.map((file) => [file, readFileSync(join(REPO_ROOT, file), "utf8")]));

/** `./dist/index.js` against a `files` entry of `dist` — the shapes npm actually resolves. */
function shippedBy(entry, files) {
  const target = entry.replace(/^\.\//, "");
  return files.some((pattern) => {
    const shipped = pattern.replace(/^\.\//, "").replace(/\/$/, "");
    return target === shipped || target.startsWith(`${shipped}/`);
  });
}

for (const [name, { dir, pkg }] of [...graph].sort((a, b) => a[0].localeCompare(b[0]))) {
  if (pkg.private === true) continue;
  const files = Array.isArray(pkg.files) ? pkg.files : [];

  const legalProblems = [];
  for (const file of LEGAL) {
    const path = join(dir, file);
    if (!exists(path)) {
      legalProblems.push(`no ${file}`);
      continue;
    }
    if (readFileSync(path, "utf8") !== rootLegal.get(file)) {
      legalProblems.push(`${file} differs from the root's`);
    }
    // Listed explicitly even for LICENSE, which npm would include anyway: a rule that reads
    // the same for both files is a rule somebody can check by eye against `files`.
    if (!files.includes(file)) legalProblems.push(`${file} is not in files, so it is not packed`);
  }

  if (legalProblems.length === 0) {
    process.stdout.write(
      `  ok  ${name} ships the licence it declares — LICENSE and NOTICE, identical to the root, both in files\n`,
    );
  } else {
    failures.push(`${name} declares ${pkg.license} and ${legalProblems.join("; ")}`);
    process.stdout.write(`  FAIL ${name} declares ${pkg.license} — ${legalProblems.join("; ")}\n`);
  }

  /**
   * And every entry point it advertises is inside the tarball.
   *
   * The neighbouring bug, and the reason this is here rather than in its own pass: `exports`
   * and `files` are two independent lists, and `exports` pointing at something `files` does not
   * ship is a package that installs and cannot be imported. `package.json` is exempt — npm
   * always includes it, which is why it can be an export target without being in `files`.
   */
  const entryPoints = [
    pkg.main,
    pkg.types,
    ...Object.values(pkg.exports ?? {}).flatMap((entry) =>
      typeof entry === "string" ? [entry] : Object.values(entry ?? {}),
    ),
  ].filter((entry) => typeof entry === "string" && entry !== "./package.json");

  const unshipped = [...new Set(entryPoints)].filter((entry) => !shippedBy(entry, files));
  if (unshipped.length === 0) {
    process.stdout.write(
      `  ok  ${name} ships what it points at — ${[...new Set(entryPoints)].join(", ")}\n`,
    );
  } else {
    failures.push(`${name} advertises ${unshipped.join(", ")} and no files entry ships them`);
    process.stdout.write(`  FAIL ${name} advertises ${unshipped.join(", ")} — not in files\n`);
  }
}

/**
 * And the graph is acyclic.
 *
 * A cycle is a build-order problem of the same family as a missing reference, and it is a
 * depth-first search over the map already built. True today; checked by nothing until now.
 */
const cycle = (() => {
  const state = new Map();
  const walk = (name, path) => {
    if (state.get(name) === "done") return undefined;
    if (state.get(name) === "open") return [...path, name];
    state.set(name, "open");
    for (const dep of graph.get(name)?.declaredWorkspace ?? []) {
      if (!graph.has(dep)) continue;
      const found = walk(dep, [...path, name]);
      if (found !== undefined) return found;
    }
    state.set(name, "done");
    return undefined;
  };
  for (const [name] of graph) {
    const found = walk(name, []);
    if (found !== undefined) return found;
  }
  return undefined;
})();

if (cycle === undefined) {
  process.stdout.write(`  ok  no cycles — ${graph.size} packages\n`);
} else {
  failures.push(`the workspace graph has a cycle: ${cycle.join(" -> ")}`);
  process.stdout.write(`  FAIL cycle — ${cycle.join(" -> ")}\n`);
}

process.stdout.write(`\n  ${checked} package(s) import from the workspace\n`);

if (failures.length > 0) {
  process.stdout.write(
    `\n${failures.length} problem(s):\n${failures.map((line) => `  ${line}`).join("\n")}\n\n` +
      "A missing reference does not fail reliably. `tsc -b` builds independent projects\n" +
      "concurrently, so it fails only when the other package's dist loses the race.\n",
  );
  process.exit(1);
}
process.stdout.write("\nEvery cross-package import is declared and referenced.\n");
