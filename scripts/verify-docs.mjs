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
 * **What this can and cannot do**, stated here rather than discovered later. Most of it
 * checks structure: counts, numbering, fields, links. One part checks truth, because it
 * turned out a machine could own it — the demo script's hypothesis verdicts are recomputed
 * from `eval/results/*.json` and compared to what the script tells a reader to say on
 * camera. That one exists because the script claimed "breach detection: not met" for eleven
 * days after a fix made it met.
 *
 * Everything else is still a person's job. This would not have caught the Bedrock
 * contradiction — both sentences were well-formed and only one was true — and nothing
 * mechanical would have.
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
// The recording guide, which makes empirical claims and had nothing checking them.
// ---------------------------------------------------------------------------
process.stdout.write("\n--- the demo script's hypothesis verdicts ---\n");

/**
 * Recomputed from the committed results, not read from prose.
 *
 * `docs/demo-script.md` told a reader to say "breach detection: not met" for eleven days
 * after a detector fix made it met. The script is what the video is recorded from, so a
 * stale verdict there is a false statement on camera — and the only thing that would have
 * caught it is a check that knows both what the script says and what the harness found.
 *
 * Each predicate is the same one its own `eval/src/bin/*.ts` evaluates. They are duplicated
 * here on purpose: a gate that imported the harness would agree with it by construction and
 * prove nothing about the document.
 */
const results = (name) => {
  const path = join(REPO_ROOT, "eval", "results", `${name}.json`);
  if (!exists(path)) return undefined;
  return JSON.parse(read(path));
};

const extraction = results("extraction");
const breach = results("breach");
const recourse = results("recourse");

if (extraction === undefined || breach === undefined || recourse === undefined) {
  want(
    "the committed evaluation results are present",
    false,
    "missing eval/results/*.json — run `pnpm eval:all`",
  );
} else {
  const verdicts = {
    H1:
      (extraction.tuned?.kind?.overall?.precision ?? 0) >= 0.9 &&
      (extraction.tuned?.kind?.overall?.recall ?? 0) >= 0.8,
    H2:
      (breach.by_kind ?? []).every((kind) => (kind.precision ?? 1) >= 0.9) &&
      (breach.overall?.kept_false_positive_rate ?? 1) < 0.05,
    H3:
      (recourse.totals?.negotiator_share ?? 0) >= 0.6 &&
      (recourse.totals?.lift ?? 0) >= 1.5 &&
      (recourse.median_rounds ?? Number.POSITIVE_INFINITY) <= 2,
  };

  const script = read(join(DOCS, "demo-script.md"));
  for (const [hypothesis, met] of Object.entries(verdicts)) {
    const stated = script.match(
      new RegExp(`\\|\\s*\\*\\*${hypothesis}\\*\\*[^|]*\\|\\s*(met|not met)\\s*\\|`),
    );
    const expected = met ? "met" : "not met";
    want(
      `the script states ${hypothesis} as the harness finds it`,
      stated?.[1] === expected,
      stated === null
        ? `no verdict row found for ${hypothesis} — did the table change shape?`
        : `says "${stated[1]}", harness says "${expected}"`,
    );
  }

  /**
   * H1's verdict is computed on the **tuned** corpus, so "met" is the generous reading by
   * construction. The script's own "Do not say" list forbids quoting it alone, so matching
   * the verdict is not enough: both held-out figures have to be on the page.
   */
  const held = extraction.held_out?.kind?.overall ?? {};
  for (const [label, value] of [
    ["precision", held.precision],
    ["recall", held.recall],
  ]) {
    const figure = `${((value ?? 0) * 100).toFixed(1)}%`;
    want(
      `the script quotes the held-out ${label}`,
      script.includes(figure),
      script.includes(figure) ? figure : `${figure} is nowhere in the script`,
    );
  }
}

/**
 * The running time, which §15 caps at under three minutes.
 *
 * The script is the plan for hitting that cap, and it is the kind of document a beat gets
 * added to without anyone re-totalling it. Each beat states a start and a duration, so the
 * two can be checked against each other: a beat whose start is not the previous one's start
 * plus its duration means the budget has drifted, and a total at or over 3:00 means the
 * submission requirement is no longer met on paper.
 */
process.stdout.write("\n--- the demo script's running time ---\n");

const beats = [
  ...read(join(DOCS, "demo-script.md")).matchAll(
    /^\*\*(\d+):(\d\d) — .*?\((?:[^)]*?·\s*)?(\d+)s\)/gm,
  ),
].map((match) => ({
  start: Number(match[1]) * 60 + Number(match[2]),
  seconds: Number(match[3]),
  label: `${match[1]}:${match[2]}`,
}));

want("the script's beats carry a start and a duration", beats.length > 0, `${beats.length} found`);

let expectedStart = 0;
let drifted = 0;
for (const beat of beats) {
  if (beat.start !== expectedStart) drifted += 1;
  expectedStart = beat.start + beat.seconds;
}
want(
  "every beat starts when the one before it ends",
  drifted === 0,
  drifted === 0 ? `${beats.length} beats, no drift` : `${drifted} beat(s) do not line up`,
);

const total = beats.length === 0 ? 0 : expectedStart;
want(
  "the take comes in under the three minutes §15 requires",
  total > 0 && total < 180,
  `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`,
);

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
  `\n${entries.length} entries, ${citations} citations and ${links} links check out, and the\n` +
    "demo script's verdicts agree with the harness. Everything else in these documents is\n" +
    "still only as true as the person who wrote it.\n",
);
