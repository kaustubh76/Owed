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
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
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

/**
 * Every entry in `docs/`, not only the Markdown ones.
 *
 * This filter was `.endsWith(".md")`, and it is why `docs/demo-capture.json` — 315 KB that
 * §5 invites a reader to open — was absent from the tree while this check passed. A gate
 * written to stop a document going missing had a blind spot the exact shape of the thing it
 * was watching for.
 */
for (const name of readdirSync(DOCS).sort()) {
  want(
    `§11's tree lists docs/${name}`,
    readme.includes(name),
    readme.includes(name) ? "listed" : "absent",
  );
}

// ---------------------------------------------------------------------------
// The architecture diagram, against the generator that produced it.
//
// `docs/architecture.excalidraw` is 221 KB of generated JSON that `readme.md` and the
// submission both point a reader at, and it was committed with nothing checking that it
// still agreed with `scripts/draw-architecture.mjs`. Edit the layout, forget to re-run, and
// the canvas quietly describes a system that has moved.
//
// Spawned rather than imported, because the generator is a script with assertions and an
// exit code, not a module — and run with `--check`, which compares in memory. A gate that
// regenerates the file it is checking cannot fail.
// ---------------------------------------------------------------------------
process.stdout.write("\n--- the architecture diagram ---\n");

const drawn = spawnSync(
  process.execPath,
  [join(REPO_ROOT, "scripts/draw-architecture.mjs"), "--check"],
  { encoding: "utf8" },
);
want(
  "docs/architecture.excalidraw agrees with its generator",
  drawn.status === 0,
  (drawn.stdout ?? "").trim().split("\n")[0] ?? drawn.error?.message ?? "did not run",
);

// ---------------------------------------------------------------------------
// Counts that drifted, and now cannot.
//
// A cross-document audit found eight numbers in this repository's prose that no longer
// matched the files they described — a 147-line script called 60 lines, a 954-line
// authorization server called "~400", 3,794 linted lines called 2,145, seven import sites
// called thirteen. Every one was true when it was written. That is the whole problem with
// a number in prose: it is a measurement with no instrument attached, and it rots quietly
// while the sentence around it stays grammatical.
//
// `readme.md` already stopped quoting a test count for exactly this reason (§14, "this repo
// already stopped quoting a test count that drifted"). The alternative to not saying it is
// measuring it, which is what this section does. Each row re-counts the thing and looks for
// the rendered figure in the document that claims it, so changing the file fails the gate
// until the sentence is updated too.
// ---------------------------------------------------------------------------
process.stdout.write("\n--- counts that drifted once, now measured ---\n");

/** Newline count, so this agrees with `wc -l` rather than being off by one. */
const lineCount = (path) => read(join(REPO_ROOT, path)).split("\n").length - 1;

const linesUnder = (dir, predicate) => {
  let total = 0;
  for (const entry of readdirSync(join(REPO_ROOT, dir), { recursive: true })) {
    const name = String(entry);
    if (!predicate(name)) continue;
    const full = join(REPO_ROOT, dir, name);
    if (statSync(full).isFile()) total += lineCount(join(dir, name));
  }
  return total;
};

// Deliberately not a total of `.mjs` lines. That is the one count here whose files are
// still being edited, so pinning it would fire the gate on every unrelated change; the
// prose dropped the figure instead, which is what §14 of the readme did with its test count.
const COUNTS = [
  {
    what: "lines in deploy/Caddyfile",
    measured: lineCount("deploy/Caddyfile"),
    rendered: String(lineCount("deploy/Caddyfile")),
    document: "docs/product-feedback.md",
  },
  {
    what: "lines of deployment shell script",
    measured: lineCount("deploy/bootstrap.sh") + lineCount("deploy/create-cli-user.sh"),
    rendered: String(lineCount("deploy/bootstrap.sh") + lineCount("deploy/create-cli-user.sh")),
    document: "docs/product-feedback.md",
  },
  {
    what: "lines in scripts/verify-graph.mjs",
    measured: lineCount("scripts/verify-graph.mjs"),
    rendered: String(lineCount("scripts/verify-graph.mjs")),
    document: "docs/friction-log.md",
  },
  {
    what: "lines of authorization server",
    measured: linesUnder(
      "packages/mcp-server/src/auth",
      (name) => name.endsWith(".ts") && !name.endsWith(".test.ts"),
    ),
    rendered: String(
      linesUnder(
        "packages/mcp-server/src/auth",
        (name) => name.endsWith(".ts") && !name.endsWith(".test.ts"),
      ),
    ),
    document: "docs/friction-log.md",
  },
];

for (const count of COUNTS) {
  const prose = read(join(REPO_ROOT, count.document));
  const found = prose.includes(count.rendered);
  want(
    `${count.document} quotes ${count.measured} ${count.what}`,
    found,
    found ? `${count.rendered} found` : `${count.rendered} is not in the document`,
  );
}

/**
 * The import-site count, which `docs/product-feedback.md` used to put at thirteen.
 *
 * It matters more than a line count does, because the sentence around it is an argument:
 * "Owed is an MCP server, not an application with an MCP wrapper". A number that says
 * thirteen when seven files import the SDK is the wrong kind of wrong for that claim.
 */
const SDK_IMPORT = 'from "@modelcontextprotocol/server"';
const sdkImporters = [...readdirSync(REPO_ROOT, { recursive: true })]
  .map(String)
  .filter(
    (name) =>
      name.endsWith(".ts") &&
      !name.endsWith(".test.ts") &&
      !name.includes("node_modules") &&
      !name.includes(`dist${sep}`),
  )
  .filter((name) => read(join(REPO_ROOT, name)).includes(SDK_IMPORT));
// Whitespace-normalised, because the prose wraps and "Seven\nimport sites" is the same
// sentence as "Seven import sites".
const feedback = read(join(DOCS, "product-feedback.md")).toLowerCase().replace(/\s+/g, " ");
const spelled = NUMBER_WORDS[sdkImporters.length];
want(
  "product-feedback quotes the real number of SDK import sites",
  spelled !== undefined && feedback.includes(`${spelled} import sites`),
  spelled === undefined
    ? `${sdkImporters.length} importers — too many for this check to spell`
    : feedback.includes(`${spelled} import sites`)
      ? `${spelled}, and the prose says so`
      : `${spelled} files import the SDK; the prose does not say "${spelled} import sites"`,
);

/**
 * The evidence kinds, which `readme.md` §8.2 listed as five when the schema froze six.
 *
 * `price_drop` is a breach kind and `price_observed` is the only evidence kind that can
 * carry a price, so a list missing it describes a system that cannot detect one of its own
 * breach kinds. Read out of the schema source rather than counted by hand.
 */
const evidenceSource = read(join(REPO_ROOT, "packages/domain/src/evidence.ts"));
// Scoped to the one enum. Read whole-file, this matched every 2-space-indented string in
// it — carrier scan statuses and doorbell event types included — and reported nine kinds
// missing from a readme that was only ever supposed to list these.
const evidenceBlock = /EvidenceKindSchema = z\.enum\(\[([^\]]*)\]\)/.exec(evidenceSource);
const evidenceKinds = [...(evidenceBlock?.[1] ?? "").matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
/**
 * Scoped to §8.2's own bullet, not the whole file.
 *
 * Searching the readme for each kind anywhere passed while the list was short, because the
 * sentence explaining *why* `price_observed` exists also names it. A check satisfied by the
 * prose about the list rather than the list is the shape this whole section is here to stop,
 * and it was caught by deleting the kind and watching the check stay green.
 */
const readmeText = read(join(REPO_ROOT, "readme.md"));
// Up to the first full stop, which is the one that ends the list. No kind contains a
// period, and this deliberately stops before the sentence that explains the list —
// that sentence names `price_observed` too, so including it let a deletion pass.
const kindsBullet = /^- Evidence kinds v1:([^.]*)/m.exec(readmeText);
const listed = kindsBullet?.[1] ?? "";
const missingKinds = evidenceKinds.filter((kind) => !listed.includes(`\`${kind}\``));
want(
  "§8.2 lists every evidence kind the schema declares",
  evidenceKinds.length > 0 && kindsBullet !== null && missingKinds.length === 0,
  evidenceKinds.length === 0
    ? "could not read the kinds out of packages/domain/src/evidence.ts"
    : kindsBullet === null
      ? "could not find the `Evidence kinds v1:` bullet in readme.md"
      : missingKinds.length === 0
        ? `all ${evidenceKinds.length}`
        : `missing ${missingKinds.join(", ")}`,
);

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

/**
 * The robustness run's shape, where the prose describes it in words.
 *
 * `readme.md` §10 and `eval/README.md` both used to say "41 passes", which counted the
 * forty jitter arms and the deterministic run and silently left out the eighteen concession
 * passes the same command produces. Replacing a derived total with the structure fixes the
 * understatement, but the structure is quoted as number-words in two files and can drift the
 * same way — so it is read out of the harness's own output here.
 */
const robustness = results("robustness");
if (robustness !== undefined) {
  const prose = {
    "readme.md": read(join(REPO_ROOT, "readme.md")).toLowerCase().replace(/\s+/g, " "),
    "eval/README.md": read(join(REPO_ROOT, "eval/README.md")).toLowerCase().replace(/\s+/g, " "),
  };
  const shape = [
    { what: "seeds", count: (robustness.seeds ?? []).length, noun: "seeds" },
    { what: "jitter levels", count: (robustness.jitters ?? []).length, noun: "jitter levels" },
    {
      what: "concession margins",
      count: (robustness.conceding?.margins ?? []).length,
      noun: "margins",
    },
  ];

  for (const { what, count, noun } of shape) {
    const spelled = NUMBER_WORDS[count];
    const phrase = `${spelled} ${noun}`;
    const quoting = Object.entries(prose).filter(([, text]) => text.includes(phrase));
    // Only files that actually quote the figure are checked — neither document is required
    // to mention all three, but one that mentions it has to get it right.
    const wrong = Object.entries(prose).filter(
      ([, text]) => text.includes(noun) && !text.includes(phrase),
    );
    want(
      `the robustness ${what} are described as ${spelled}`,
      spelled !== undefined && wrong.length === 0,
      spelled === undefined
        ? `${count} is past what this check can spell`
        : wrong.length === 0
          ? `${count}, quoted by ${quoting.length === 0 ? "neither document" : quoting.map(([name]) => name).join(" and ")}`
          : `${wrong.map(([name]) => name).join(", ")} mentions ${noun} but not "${phrase}"`,
    );
  }
}

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
// The utterances, which exist in three independent copies
// ---------------------------------------------------------------------------
process.stdout.write("\n--- the words a presenter says, in the three places they live ---\n");

/**
 * The same strings are written out three times and nothing tied them together.
 *
 * `apps/home/src/VoiceBar.tsx` holds the chips a household can click.
 * `docs/demo-script.md` tells a presenter which chip to click, by ordinal and by quoting
 * the words. `scripts/verify-ui.mjs` hardcodes those words again as Playwright button
 * names. Change the chip and the browser gate fails, which is fine. Change the *script*
 * and nothing fails at all — the recording guide would simply be wrong, on camera.
 *
 * `**[gate]**` has the same problem one level up: the script declares which beats
 * `verify:ui` asserts, and that mapping was maintained entirely by hand. A beat could
 * claim browser coverage it never had.
 *
 * So: the chips are the single source, and both documents are checked against them.
 */
const voiceBar = read(join(REPO_ROOT, "apps", "home", "src", "VoiceBar.tsx"));
const chipBlock = /const SCRIPT = \[([\s\S]*?)\] as const;/.exec(voiceBar);
const chips = chipBlock === null ? [] : [...chipBlock[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);

want(
  "the home still declares its chips where this can read them",
  chips.length > 0,
  chips.length === 0
    ? "no `const SCRIPT = [...] as const` in VoiceBar.tsx"
    : `${chips.length} chip(s)`,
);

const uiGate = read(join(REPO_ROOT, "scripts", "verify-ui.mjs"));
const demoScript = read(join(DOCS, "demo-script.md"));

/**
 * Every chip is driven by the browser gate.
 *
 * A chip nothing clicks is a path a household can take that no check has ever taken.
 */
const undriven = chips.filter((chip) => !uiGate.includes(chip));
want(
  "every chip the home offers is driven by verify:ui",
  // `chips.length > 0` is load-bearing: renaming the array makes `chips` empty, and
  // "every one of nothing is driven" is true. Proved by renaming it and watching this
  // report ok on an empty list before the condition was added.
  chips.length > 0 && undriven.length === 0,
  chips.length === 0
    ? "no chips were read, so this proves nothing"
    : undriven.length === 0
      ? chips.join(" · ")
      : `never clicked by the gate: ${undriven.join(", ")}`,
);

/**
 * The ordinals the script navigates by.
 *
 * "the first chip" has to mean the first one, or a presenter clicks the wrong button.
 */
const ORDINALS = ["first", "second", "third", "fourth"];
const misordered = [];
for (const [index, word] of ORDINALS.entries()) {
  if (!new RegExp(`\\b${word} chip\\b`).test(demoScript)) continue;
  const chip = chips[index];
  if (chip !== undefined && !demoScript.includes(chip)) {
    misordered.push(`"${word} chip" is referenced but ${JSON.stringify(chip)} is never quoted`);
  }
}
want(
  "and the script's chip ordinals name chips that exist",
  misordered.length === 0,
  misordered.length === 0
    ? `${ORDINALS.filter((w) => new RegExp(`\\b${w} chip\\b`).test(demoScript)).length} ordinal(s) checked`
    : misordered.join("; "),
);

/**
 * And a beat that claims the gate asserts it must at least say words the gate sends.
 *
 * Only the quoted part of the heading is read: `**0:12 — "Alexa, what am I owed?"**` names
 * an utterance, `**1:28 — answer it.**` does not, and a beat that quotes nothing is making
 * no claim this can check.
 */
const gated = [
  ...demoScript.matchAll(/^\*\*(\d+:\d\d) — (.*?)\*\*\s*\*\([^)]*\)\*\s*\*\*\[gate\]\*\*/gm),
];
const unasserted = [];
for (const [, at, heading] of gated) {
  for (const [, quoted] of heading.matchAll(/"([^"]+)"/g)) {
    if (!uiGate.includes(quoted)) unasserted.push(`${at} quotes ${JSON.stringify(quoted)}`);
  }
}
want(
  "every [gate] beat quoting an utterance is one verify:ui drives",
  unasserted.length === 0,
  unasserted.length === 0
    ? `${gated.length} gated beat(s)`
    : `claims gate coverage the gate does not give: ${unasserted.join(", ")}`,
);

// ---------------------------------------------------------------------------
// readme §11: "the same sequence .github/workflows/verify.yml runs on every push"
// ---------------------------------------------------------------------------
process.stdout.write("\n--- the gate chain, against the workflow that claims to run it ---\n");

/**
 * The readme says the workflow runs the same sequence as `pnpm verify`. It did, until a
 * gate was added to one of them.
 *
 * `verify:eval` went into the `verify` script and nowhere near CI, because this job lists
 * the gates as individual steps rather than calling `pnpm verify` — which it does
 * deliberately, so a failure names the gate that failed and the second timezone pass can
 * sit between two of them. The gate was written, mutation-proved, documented and
 * committed, and protected nothing on any machine but the author's. A full run went green
 * without executing it.
 *
 * The first version of this check read both sides with one regex over the whole file,
 * `/^\s*(?:- )?run: +pnpm +([\w:]+)/gm`, and passed only because the chain and the
 * workflow happened to be written in the single form it handled. It claimed in a comment
 * to handle `run: |` blocks and could not — `run: +pnpm` cannot cross a newline, and there
 * is such a block in the file. `pnpm --filter y z` matched nothing, because `[\w:]+`
 * cannot begin at `-`, and that is the house style for every package-scoped script.
 * `pnpm run x` captured `run`, reporting the real gate missing *and* `run` as an
 * unexplained extra. A gate written with a flag on the chain side became the gate name
 * `"test --coverage"`, which can never match, so flags were tolerated in CI and fatal in
 * `package.json`. And matching over the whole file meant a step in some second job would
 * satisfy "every gate is a step" while the `verify` job never ran it.
 *
 * So both sides go through one resolver instead, and the workflow is read as steps rather
 * than as text.
 */

/**
 * The pnpm scripts a shell snippet invokes, in order.
 *
 * Skips an env prefix (`TZ=... pnpm test`), skips flags, unwraps `run`/`exec`, and keeps a
 * `--filter` as part of the identity — `pnpm --filter @owed/eval breach` is a different
 * command from `pnpm breach` and must not match it.
 */
function pnpmScripts(snippet) {
  const found = [];
  for (const command of snippet.split(/&&|\|\||;|\n/)) {
    const words = command
      .trim()
      .split(/\s+/)
      .filter((word) => word !== "");
    // An env prefix is any leading NAME=value pair.
    let at = 0;
    while (at < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[at] ?? "")) at += 1;
    if ((words[at] ?? "").replace(/^.*\//, "").replace(/\.(cmd|exe)$/, "") !== "pnpm") continue;
    at += 1;

    let filter;
    let script;
    while (at < words.length) {
      const word = words[at] ?? "";
      if (word === "--filter" || word === "-F") {
        filter = words[at + 1];
        at += 2;
        continue;
      }
      const inline = /^--filter=(.+)$/.exec(word);
      if (inline) {
        filter = inline[1];
        at += 1;
        continue;
      }
      if (word === "run" || word === "exec") {
        at += 1;
        continue;
      }
      if (word.startsWith("-")) {
        at += 1;
        continue;
      }
      script = word;
      break;
    }
    if (script !== undefined) found.push(filter === undefined ? script : `${filter} ${script}`);
  }
  return found;
}

/**
 * The `run:` scripts of one job's steps, with the steps that do not always run left out.
 *
 * Indentation-scoped rather than parsed as YAML, which keeps this dependency-free — but
 * scoped to the named job, so another job's steps cannot answer for this one. A step
 * carrying `if:` or `continue-on-error: true` is reported separately: it is in the file,
 * and it is not something the chain can rely on.
 */
function jobSteps(workflowText, job) {
  const lines = workflowText.split("\n");
  const jobAt = lines.findIndex((line) => new RegExp(`^  ${job}:\\s*$`).test(line));
  if (jobAt < 0) return undefined;

  // The job ends at the next line indented two spaces or less that is not blank.
  let end = lines.length;
  for (let index = jobAt + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim() !== "" && /^ {0,2}\S/.test(line)) {
      end = index;
      break;
    }
  }
  const body = lines.slice(jobAt + 1, end);

  const stepsAt = body.findIndex((line) => /^ {4}steps:\s*$/.test(line));
  if (stepsAt < 0) return { steps: [], conditional: [] };

  // Split the steps block into steps at each `- ` bullet.
  const steps = [];
  let current;
  for (const line of body.slice(stepsAt + 1)) {
    if (/^ {6}- /.test(line)) {
      if (current !== undefined) steps.push(current);
      current = [line.replace(/^ {6}- /, "")];
    } else if (current !== undefined) {
      current.push(line.replace(/^ {8}/, ""));
    }
  }
  if (current !== undefined) steps.push(current);

  const always = [];
  const conditional = [];
  for (const step of steps) {
    const text = step.join("\n");
    // `run: pnpm x` and `run: |` with the commands on following lines both end up here,
    // because the whole step is handed to the resolver rather than one matched line.
    const scripts = pnpmScripts(text.replace(/^run: *\|?/m, ""));
    if (scripts.length === 0) continue;
    const gated = /^if:/m.test(text) || /^continue-on-error:\s*true/m.test(text);
    for (const script of scripts) (gated ? conditional : always).push(script);
  }
  return { steps: always, conditional };
}

const rootPackage = JSON.parse(read(join(REPO_ROOT, "package.json")));
const chain = pnpmScripts(rootPackage.scripts?.verify ?? "");

const workflowPath = join(REPO_ROOT, ".github", "workflows", "verify.yml");
const workflow = exists(workflowPath) ? read(workflowPath) : "";
const job = jobSteps(workflow, "verify");

want(
  "the workflow has a `verify` job that runs pnpm steps",
  chain.length > 0 && job !== undefined && job.steps.length > 0,
  job === undefined
    ? "no `verify` job in .github/workflows/verify.yml"
    : `${chain.length} gate(s) in the chain, ${new Set(job.steps).size} distinct step(s) in the job`,
);

const steps = job?.steps ?? [];
const conditional = job?.conditional ?? [];

const missing = chain.filter((gate) => !steps.includes(gate));
want(
  "every gate in `pnpm verify` is a step in the workflow",
  missing.length === 0,
  missing.length === 0
    ? chain.join(" -> ")
    : `not run on push: ${missing.join(", ")}${
        missing.some((gate) => conditional.includes(gate))
          ? " (present but behind an `if:` or `continue-on-error`)"
          : ""
      }`,
);

/**
 * And the other direction, because `verify:graph` taught this repository to check both.
 *
 * A gate added to the workflow alone runs on every push, so it cannot be silently absent —
 * but it means `pnpm verify` has stopped being what a contributor can run before pushing,
 * which is the only reason that script exists. `install` is named here with its reason
 * rather than tolerated by pattern, so a second one has to be argued for. `test` is *not*
 * listed: it is in the chain, so it never reaches this check — the previous version listed
 * it and then reported "2 step(s) extra by design", counting a dead entry.
 */
const EXTRA_STEPS = {
  install: "dependencies, which the chain assumes are already there",
  "verify:capture":
    "re-derives docs/demo-capture.json by booting four processes and negotiating; CI is" +
    " where an artifact's freshness matters, and the local chain is meant to stay fast",
};
const unexplained = [...new Set(steps)].filter(
  (step) => !chain.includes(step) && !(step in EXTRA_STEPS),
);
want(
  "and the workflow runs no gate the chain does not",
  unexplained.length === 0,
  unexplained.length === 0
    ? `extra by design: ${Object.keys(EXTRA_STEPS).join(", ")}`
    : `in CI only, so \`pnpm verify\` does not run it: ${unexplained.join(", ")}`,
);

/**
 * And an entry here is a promise that CI runs it, so it has to.
 *
 * `EXTRA_STEPS` began as permission — a step allowed to be in the workflow without being in
 * the chain. Permission alone reopens the hole it was built for: `verify:capture` is in CI
 * and nowhere else, so deleting that one line would leave the script unrun by anything,
 * which is exactly the state it was added to escape. Listing it here now requires it.
 */
const promised = Object.keys(EXTRA_STEPS).filter((step) => !steps.includes(step));
want(
  "and every step named extra by design is actually there",
  promised.length === 0,
  promised.length === 0
    ? `${Object.keys(EXTRA_STEPS).length} named, ${Object.keys(EXTRA_STEPS).length} present`
    : `named extra by design but not in the workflow: ${promised.join(", ")}`,
);

/**
 * Order, by *last* appearance rather than first.
 *
 * `pnpm test` runs twice — once plainly and once under `TZ=Pacific/Kiritimati` — and
 * reading `indexOf` meant only the first was ever considered, so moving the plain one
 * after `verify:eval` would have passed. Taking the last occurrence means every gate in
 * the chain has to be finished with before the next one starts, which is what "the same
 * sequence" claims.
 */
const positions = chain.map((gate) => steps.lastIndexOf(gate));
const ordered = positions.every(
  (position, index) => index === 0 || position < 0 || positions[index - 1] < position,
);
want(
  "and in the same order",
  ordered,
  // A gate the workflow does not run has no position to be out of, and the check above
  // already names it; this one is about the gates that are there.
  ordered ? `${chain.length - missing.length} gate(s) present, in order` : "the orders disagree",
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
