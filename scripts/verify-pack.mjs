#!/usr/bin/env node
/**
 * Open the tarball. Everything else about publishing is a declaration.
 *
 * `verify:graph` checks that a publishable package *declares* `license`, `files`, `exports` and
 * has a README, and its own comment calls that "the packaging half of the same claim". Three of
 * those four are strings in `package.json`. All five publishable packages passed it while
 * shipping no `NOTICE` and three of them shipping compiled test files.
 *
 * **What packing showed, which is narrower than I first claimed.** `LICENSE` and `NOTICE` live
 * at the repository root and existed in none of the five packages, so I expected the archives to
 * carry neither. Packing one in its committed state said otherwise: **pnpm 10.18.2 copies the
 * workspace root's licence into a packed workspace package that has none**, so `LICENSE` was
 * already there, byte-identical, by the packer's courtesy. `NOTICE` was not, and nothing copies
 * it — which matters, because Apache-2.0 §4(d) requires a redistribution to carry the NOTICE's
 * attribution notices and that file is where the copyright holder and the third-party notices
 * are. The per-package copies now make both true under *any* packer rather than under this one:
 * `npm pack` performs no such substitution.
 *
 * The division of labour between the two gates is therefore not symmetrical, and worth saying
 * plainly: deleting a package's own `LICENSE` is **invisible here**, because pnpm quietly
 * supplies the root's again. `verify-graph.mjs` reads the file system and catches that. This
 * gate catches what only the archive knows.
 *
 * That part is now gated statically too, in `verify-graph.mjs`, because it is cheap and needs no
 * build. This exists because the static version cannot see two things that only appear once the
 * archive is built:
 *
 * - **what `files` actually resolves to.** `["dist"]` shipped `dist/protocol.test.js` — the
 *   conformance suite's own test, importing `vitest`, which is a devDependency the tarball does
 *   not depend on — plus `dist/.tsbuildinfo`, in three of the five packages. Compiling tests is
 *   deliberate and worth keeping: `tsc -b` type-checks them, which is how a real type error in
 *   a test was caught. Shipping them is not. The negations in `files` fix it and *this* is what
 *   proves the negations work, since `files` honouring `!` is a packer behaviour, not a promise.
 * - **whether an entry point is inside.** `exports` and `files` are independent lists, and a
 *   package whose `exports` names something `files` omits installs and cannot be imported.
 *
 * Offline: `pnpm pack` builds an archive from the working tree and contacts no registry. It
 * needs `dist`, so this runs after `build` in the chain, and says so plainly if it is missing.
 *
 * **Writes nothing into the repository.** The archives go to a temp directory, for the reason
 * `verify-eval.mjs` sets out at length: a gate that writes into the tree it is checking is a
 * gate that can leave the tree worse than it found it.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGES = join(REPO_ROOT, "packages");

/** Packing five archives is a few seconds; neither bound is near normal. */
const PACK_TIMEOUT_MS = 2 * 60_000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/** Every publishable package is expected to carry these, verbatim from the root. */
const LEGAL = ["LICENSE", "NOTICE"];

/** Shipped by accident when `files` says `dist`: build metadata and compiled tests. */
const NEVER_SHIP = [
  { label: "compiled tests", matches: (path) => /\.test\.(js|d\.ts)(\.map)?$/.test(path) },
  { label: "build metadata", matches: (path) => /tsbuildinfo$/.test(path) },
];

const failures = [];
function want(label, ok, detail) {
  process.stdout.write(`  ${ok ? "ok " : "FAIL"} ${label} — ${detail}\n`);
  if (!ok) failures.push(`${label}: ${detail}`);
}

/** The same rule `verify-graph.mjs` uses: a package is publishable unless it says otherwise. */
function publishable() {
  const found = [];
  for (const entry of readdirSync(PACKAGES, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifest = join(PACKAGES, entry.name, "package.json");
    if (!existsSync(manifest)) continue;
    const pkg = JSON.parse(readFileSync(manifest, "utf8"));
    if (pkg.private === true) continue;
    found.push({ dir: join(PACKAGES, entry.name), pkg });
  }
  return found.sort((a, b) => a.pkg.name.localeCompare(b.pkg.name));
}

/** `./dist/index.js` as it appears inside the archive, which prefixes everything with `package/`. */
const inside = (entry) => entry.replace(/^\.\//, "");

const packages = publishable();
process.stdout.write("--- the archives these packages would publish ---\n");
want(
  "there are publishable packages to pack",
  packages.length >= 5,
  `${packages.length}: ${packages.map(({ pkg }) => pkg.name).join(", ")}`,
);

const missingBuilds = packages.filter(({ dir }) => !existsSync(join(dir, "dist")));
if (missingBuilds.length > 0) {
  process.stdout.write(
    `\n✗ ${missingBuilds.map(({ pkg }) => pkg.name).join(", ")} ${
      missingBuilds.length === 1 ? "has" : "have"
    } no dist/.\n\n` +
      "  Run `pnpm build` first. This gate packs what would actually be published, and\n" +
      "  `dist/` is gitignored, so an unbuilt tree produces an archive missing its own\n" +
      "  entry point — which would be reported below as a packaging defect it is not.\n",
  );
  process.exit(1);
}

const out = mkdtempSync(join(tmpdir(), "owed-pack-"));
try {
  for (const { pkg } of packages) {
    const run = spawnSync("pnpm", ["--filter", pkg.name, "pack", "--pack-destination", out], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: MAX_OUTPUT_BYTES,
      timeout: PACK_TIMEOUT_MS,
    });
    if (run.error !== undefined || run.status !== 0) {
      const why =
        run.error !== undefined
          ? run.error.message
          : run.signal !== null
            ? `killed by ${run.signal}`
            : `exited ${run.status}`;
      want(`${pkg.name} packs`, false, why);
      continue;
    }

    // `pnpm pack` names the archive after the package and version; find it rather than
    // reconstructing the name, which differs for scoped packages.
    const archive = readdirSync(out).find((file) =>
      file.startsWith(`${pkg.name.replace("@", "").replace("/", "-")}-${pkg.version}`),
    );
    if (archive === undefined) {
      want(`${pkg.name} packs`, false, `no archive appeared in ${out}`);
      continue;
    }

    const listing = spawnSync("tar", ["-tzf", join(out, archive)], {
      encoding: "utf8",
      maxBuffer: MAX_OUTPUT_BYTES,
      timeout: PACK_TIMEOUT_MS,
    });
    if (listing.status !== 0) {
      want(`${pkg.name} packs`, false, `could not read ${archive}`);
      continue;
    }
    const contents = listing.stdout
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => line.replace(/^package\//, ""));

    const absent = [...LEGAL, "README.md"].filter((file) => !contents.includes(file));
    want(
      `${pkg.name} carries its licence`,
      absent.length === 0,
      absent.length === 0
        ? `LICENSE, NOTICE and README.md are in ${archive}`
        : `${archive} is missing ${absent.join(", ")}`,
    );

    for (const file of LEGAL) {
      if (!contents.includes(file)) continue;
      const packed = spawnSync("tar", ["-xzOf", join(out, archive), `package/${file}`], {
        encoding: "utf8",
        maxBuffer: MAX_OUTPUT_BYTES,
        timeout: PACK_TIMEOUT_MS,
      });
      want(
        `${pkg.name}'s packed ${file} is the repository's`,
        packed.status === 0 && packed.stdout === readFileSync(join(REPO_ROOT, file), "utf8"),
        packed.status !== 0
          ? "could not be extracted from the archive"
          : packed.stdout === readFileSync(join(REPO_ROOT, file), "utf8")
            ? "byte-identical"
            : `${packed.stdout.length} bytes packed against ` +
              `${readFileSync(join(REPO_ROOT, file), "utf8").length} at the root — they have drifted`,
      );
    }

    const entryPoints = [
      pkg.main,
      pkg.types,
      ...Object.values(pkg.exports ?? {}).flatMap((entry) =>
        typeof entry === "string" ? [entry] : Object.values(entry ?? {}),
      ),
    ]
      .filter((entry) => typeof entry === "string" && entry !== "./package.json")
      .map(inside);
    const unreachable = [...new Set(entryPoints)].filter((entry) => !contents.includes(entry));
    want(
      `${pkg.name} ships what it points at`,
      unreachable.length === 0,
      unreachable.length === 0
        ? [...new Set(entryPoints)].join(", ")
        : `declared and not in the archive: ${unreachable.join(", ")}`,
    );

    const strays = NEVER_SHIP.flatMap(({ label, matches }) => {
      const hits = contents.filter(matches);
      return hits.length === 0 ? [] : [`${hits.length} ${label} (${hits[0]}…)`];
    });
    want(
      `${pkg.name} ships nothing a consumer cannot use`,
      strays.length === 0,
      strays.length === 0
        ? `${contents.length} file(s), none of them tests or build metadata`
        : strays.join("; "),
    );
  }
} finally {
  rmSync(out, { recursive: true, force: true });
}

if (failures.length > 0) {
  process.stdout.write(
    `\n${failures.length} problem(s):\n${failures.map((line) => `  ${line}`).join("\n")}\n\n` +
      "These are what a consumer would install. `readme.md` §15 says three of these packages\n" +
      "lift out of this repository as they stand, and `NOTICE` says all five are licensed for\n" +
      "use outside it — so the archive is the artifact those sentences are about.\n",
  );
  process.exitCode = 1;
} else {
  process.stdout.write(
    `\nEvery publishable package carries the licence it declares and nothing it cannot use.\n`,
  );
}
