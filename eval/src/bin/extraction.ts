import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { generateExtractionCorpus } from "../extraction/corpus.js";
import { heldOutMessages } from "../extraction/heldout.js";
import { measureExtraction } from "../extraction/measure.js";

const report = measureExtraction(generateExtractionCorpus());
const pct = (value: number | undefined) =>
  value === undefined ? "  —  " : `${(value * 100).toFixed(1)}%`;

process.stdout.write(`
Promise extraction — H1

  ${report.messages} labelled messages. Rule-based, no model.

  kind only                        precision    recall
    generated (templated)     ${pct(report.kind.by_set.generated?.precision).padStart(10)} ${pct(report.kind.by_set.generated?.recall).padStart(9)}
    authored (prose)          ${pct(report.kind.by_set.authored?.precision).padStart(10)} ${pct(report.kind.by_set.authored?.recall).padStart(9)}
    overall                   ${pct(report.kind.overall.precision).padStart(10)} ${pct(report.kind.overall.recall).padStart(9)}

  kind and resolved timing
    generated                 ${pct(report.exact.by_set.generated?.precision).padStart(10)} ${pct(report.exact.by_set.generated?.recall).padStart(9)}
    authored                  ${pct(report.exact.by_set.authored?.precision).padStart(10)} ${pct(report.exact.by_set.authored?.recall).padStart(9)}
    overall                   ${pct(report.exact.overall.precision).padStart(10)} ${pct(report.exact.overall.recall).padStart(9)}

  by promise kind
`);

for (const [kind, tally] of Object.entries(report.kind.by_kind)) {
  process.stdout.write(
    `    ${kind.padEnd(20)} ${pct(tally.precision).padStart(9)} ${pct(tally.recall).padStart(9)}   (${tally.true_positive} right, ${tally.false_positive} wrong, ${tally.false_negative} missed)\n`,
  );
}

const met = (report.kind.overall.precision ?? 0) >= 0.9 && (report.kind.overall.recall ?? 0) >= 0.8;
process.stdout.write(
  `\n  H1 (>= 0.9 precision, >= 0.8 recall on kinds): ${met ? "met" : "NOT met"}\n`,
);

if (report.false_alarms.length > 0) {
  process.stdout.write(
    `\n  read a promise out of ${report.false_alarms.length} message(s) that made none:\n`,
  );
  for (const alarm of report.false_alarms) {
    process.stdout.write(`    ${alarm.id}  read ${alarm.read.join(", ")}  — ${alarm.note}\n`);
  }
}
if (report.misses.length > 0) {
  process.stdout.write(`\n  missed ${report.misses.length} message(s):\n`);
  for (const miss of report.misses) {
    process.stdout.write(
      `    ${miss.id}  wanted ${miss.expected.join(", ")}${miss.read.length > 0 ? `, read ${miss.read.join(", ")}` : ""}  — ${miss.note}\n`,
    );
  }
}

/**
 * The held-out set, run last and never tuned against.
 *
 * The corpus above stopped being evidence the moment the extractor was changed in
 * response to it. This is the number that means something.
 */
const heldOut = measureExtraction(heldOutMessages());
process.stdout.write(`
  held out — ${heldOut.messages} messages the extractor has never been run against

    kind only                 ${pct(heldOut.kind.overall.precision)} precision, ${pct(heldOut.kind.overall.recall)} recall
    kind and timing           ${pct(heldOut.exact.overall.precision)} precision, ${pct(heldOut.exact.overall.recall)} recall
`);
if (heldOut.false_alarms.length > 0) {
  process.stdout.write(
    `\n    read a promise out of ${heldOut.false_alarms.length} message(s) that made none:\n`,
  );
  for (const alarm of heldOut.false_alarms) {
    process.stdout.write(`      ${alarm.id}  read ${alarm.read.join(", ")}  — ${alarm.note}\n`);
  }
}
if (heldOut.misses.length > 0) {
  process.stdout.write(`\n    missed ${heldOut.misses.length} message(s):\n`);
  for (const miss of heldOut.misses) {
    process.stdout.write(
      `      ${miss.id}  wanted ${miss.expected.join(", ")}${miss.read.length > 0 ? `, read ${miss.read.join(", ")}` : ""}  — ${miss.note}\n`,
    );
  }
}

const dir = fileURLToPath(new URL("../../results/", import.meta.url));
mkdirSync(dir, { recursive: true });
writeFileSync(
  `${dir}extraction.json`,
  `${JSON.stringify({ tuned: report, held_out: heldOut }, null, 2)}\n`,
);
process.stdout.write("\n  written to eval/results/extraction.json\n");
