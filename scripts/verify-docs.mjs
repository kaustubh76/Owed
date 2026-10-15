#!/usr/bin/env node
/**
 * Check the documents the way the deployment and the project graph are checked.
 *
 * Nothing read the documentation. Every prose defect this project has found was found by a
 * person reading: six tool names that did not exist, a sequence diagram in rupees, an IAM
 * policy described as eight actions when it is nine, `product-feedback.md` missing from the
 * repository tree it is supposed to appear in, and a sentence saying the Bedrock boundary
 * was untested months after a test was written for it.
 *
 * Adding five friction-log entries is what forced the issue: the entry count is quoted in
 * three separate files, and the entries are cited **by number** from `readme.md` and
 * `docs/contract-v1.md`, so renumbering them silently breaks a cross-reference that looks
 * fine in every diff.
 *
 * **What this cannot do**, stated here rather than discovered later: it checks structure,
 * not truth. It would not have caught the Bedrock contradiction, because both sentences
 * were well-formed and only one was true. Nothing mechanical would have. The checks below
 * are the subset a machine can own, which is exactly why the ones it cannot own are worth a
 * person's attention.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DOCS = join(REPO_ROOT, "docs");

const failures = [];

function want(label, ok, detail) {
  process.stdout.write(`  ${ok ? "ok " : "FAIL"} ${label} — ${detail}\n`);
  if (!ok) failures.push(`${label}: ${detail}`);
}

function exists(path) {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

const read = (path) => readFileSync(path, "utf8");

/**
 * Counts in this project's prose are spelled out, so a numeral check would not find them.
 * Only as far as the entry count could plausibly reach.
 */
const NUMBER_WORDS = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
  "twenty",
  "twenty-one",
  "twenty-two",
  "twenty-three",
  "twenty-four",
  "twenty-five",
  "twenty-six",
  "twenty-seven",
  "twenty-eight",
  "twenty-nine",
  "thirty",
];

process.stdout.write("Owed documentation gate\n\n");

// ---------------------------------------------------------------------------
// The friction log: its own structure, and the count every other file quotes.
// ---------------------------------------------------------------------------
process.stdout.write("--- the friction log ---\n");

const frictionLog = read(join(DOCS, "friction-log.md"));
const entries = [...frictionLog.matchAll(/^## (\d+)\. (.+)$/gm)].map((match) => ({
  number: Number(match[1]),
  title: match[2],
  at: match.index ?? 0,
}));

want("the log has entries at all", entries.length > 0, `${entries.length} found`);

/**
 * Numbered 1..n with no gaps and no repeats. A gap means an entry was deleted and the
 * citations after it now point one place to the left.
 */
const numbers = entries.map((entry) => entry.number);
const expected = entries.map((_, index) => index + 1);
want(
  "entries are numbered 1..n with no gaps or repeats",
  JSON.stringify(numbers) === JSON.stringify(expected),
  numbers.join(", "),
);

/** The five fields every entry carries, in this order. */
const FIELDS = ["Task", "Expected", "Actual", "Workaround", "Suggestion"];
for (const [index, entry] of entries.entries()) {
  const body = frictionLog.slice(entry.at, entries[index + 1]?.at ?? frictionLog.length);

  const attributed = /^\*\*(?:Tool|Surface):\*\* .+ · \*\*Severity: [a-z -]+\*\*/m.test(body);
  const positions = FIELDS.map((field) => body.indexOf(`**${field}.**`));
  const present = positions.every((position) => position >= 0);
  const ordered = positions.every((position, i) => i === 0 || position > (positions[i - 1] ?? -1));

  const missing = FIELDS.filter((_, i) => (positions[i] ?? -1) < 0);
  want(
    `entry ${entry.number} is attributed and carries the five fields in order`,
    attributed && present && ordered,
    !attributed
      ? "no **Tool:**/**Surface:** · **Severity:** line"
      : missing.length > 0
        ? `missing ${missing.join(", ")}`
        : ordered
          ? "ok"
          : "fields out of order",
  );
}

/**
 * The count, wherever it is quoted. A number in three files is a number that goes stale in
 * two of them.
 */
const QUOTED_IN = [
  ["readme.md", /per-tool friction, ([a-z-]+) entries/],
  ["readme.md", /friction-log\.md\)\*\*, ([a-z-]+) entries/],
  ["docs/product-feedback.md", /friction-log\.md\)\*\* — ([a-z-]+) entries/],
];
const asWord = NUMBER_WORDS[entries.length] ?? String(entries.length);
for (const [file, pattern] of QUOTED_IN) {
  const found = read(join(REPO_ROOT, file)).match(pattern);
  want(
    `${file} quotes the right entry count`,
    found?.[1] === asWord,
    found === null
      ? "no count found — did the wording change?"
      : `says "${found[1]}", is "${asWord}"`,
  );
}

// ---------------------------------------------------------------------------
// Citations by number. These are the ones a renumbering breaks invisibly.
// ---------------------------------------------------------------------------
process.stdout.write("\n--- citations of the friction log by number ---\n");

const markdown = [
  "readme.md",
  ...readdirSync(DOCS)
    .filter((name) => name.endsWith(".md"))
    .map((name) => `docs/${name}`),
];

let citations = 0;
for (const file of markdown) {
  const text = read(join(REPO_ROOT, file));
  // "friction-log.md §10", "§10–11", "§10-11", "§10 and §11"
  for (const match of text.matchAll(/friction-log\.md[^.\n]*?§(\d+)(?:\s*[–-]\s*(\d+))?/g)) {
    const from = Number(match[1]);
    const to = match[2] === undefined ? from : Number(match[2]);
    for (let n = from; n <= to; n += 1) {
      citations += 1;
      want(
        `${file} cites friction-log §${n}`,
        numbers.includes(n),
        numbers.includes(n) ? `"${entries[n - 1]?.title.slice(0, 54)}"` : "no such entry",
      );
    }
  }
}
want("at least one citation was checked", citations > 0, `${citations} checked`);

// ---------------------------------------------------------------------------
// Relative links. A dead link in a submission is a judge hitting a 404.
// ---------------------------------------------------------------------------
process.stdout.write("\n--- relative links in readme.md and docs/ ---\n");

let links = 0;
let broken = 0;
for (const file of markdown) {
  const from = join(REPO_ROOT, file);
  for (const match of read(from).matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = match[1] ?? "";
    if (/^(https?:|mailto:|#)/.test(target)) continue;
    links += 1;
    // Strip an anchor; the file is what we can check.
    const path = resolve(dirname(from), target.split("#")[0] ?? "");
    if (!exists(path)) {
      broken += 1;
      want(`${file} links ${target}`, false, "no such file");
    }
  }
}
want("every relative link resolves", broken === 0, `${links} checked, ${broken} broken`);

// ---------------------------------------------------------------------------
// The repository tree in §11. This is how product-feedback.md went missing from it.
// ---------------------------------------------------------------------------
process.stdout.write("\n--- the §11 repository tree ---\n");

const readme = read(join(REPO_ROOT, "readme.md"));
for (const name of readdirSync(DOCS)
  .filter((entry) => entry.endsWith(".md"))
  .sort()) {
  want(
    `§11's tree lists docs/${name}`,
    readme.includes(name),
    readme.includes(name) ? "listed" : "absent",
  );
}

// ---------------------------------------------------------------------------
if (failures.length > 0) {
  process.stdout.write(`\n${failures.length} problem(s):\n`);
  for (const line of failures) process.stdout.write(`  ${line}\n`);
  process.stdout.write(
    "\nThese are structural. A document can pass every one of them and still say something\n" +
      "untrue — that part is a person's job, and always was.\n",
  );
  process.exit(1);
}
process.stdout.write(
  `\n${entries.length} entries, ${citations} citations and ${links} links check out.\n` +
    "Structure only: whether any of it is true is not something this can tell you.\n",
);
