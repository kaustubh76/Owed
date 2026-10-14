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
