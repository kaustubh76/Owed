import { generateBreachCorpus } from "../breach/corpus.js";
import { measureBreachDetection } from "../breach/measure.js";
import { writeReport } from "../results.js";

const report = measureBreachDetection(generateBreachCorpus());
const pct = (value: number | undefined) =>
  value === undefined ? "  —  " : `${(value * 100).toFixed(1)}%`;

process.stdout.write(`
Breach detection — H2

  ${report.cases} scripted timelines, ${report.parameters.cases_per_kind} per breach kind.
  Precision and recall are measured on cases at coverage >= ${report.parameters.observable_coverage_min}.

  by breach kind                  precision   recall   kept FPR   held back
`);

for (const kind of report.by_kind) {
  process.stdout.write(
    `    ${kind.kind.padEnd(20)} ${pct(kind.precision).padStart(9)} ${pct(kind.recall).padStart(8)} ` +
      `${pct(kind.kept_false_positive_rate).padStart(10)} ${`${kind.held_back}/${kind.held_back_cases}`.padStart(11)}\n`,
  );
}

process.stdout.write(`
  overall                ${pct(report.overall.precision)} precision, ${pct(report.overall.recall)} recall
  false positives on kept scenarios     ${pct(report.overall.kept_false_positive_rate)}
  held back below the coverage gate     ${pct(report.overall.held_back_share)}
`);

/**
 * H2 as pre-registered, which is not what this used to evaluate.
 *
 * The label has always said "0.9 precision **per kind**" and the predicate tested
 * `report.overall.precision` — the pooled figure, which is 0.94 while two kinds sit at 0.80
 * and 0.75. It printed "NOT met" on the false-positive clause alone, so the per-kind bar in
 * its own output string was never checked. Had the false positives been fixed first, this
 * would have printed "met" without ever asking the question it claims to ask.
 *
 * Corrected before any detector was touched, so the measurement is asking the
 * pre-registered question before anything tries to satisfy it.
 */
const belowBar = report.by_kind.filter((kind) => (kind.precision ?? 1) < 0.9);
const met = belowBar.length === 0 && report.overall.kept_false_positive_rate < 0.05;
process.stdout.write(
  `\n  H2 (>= 0.9 precision per kind, < 5% false positives on kept): ${met ? "met" : "NOT met"}\n`,
);
if (belowBar.length > 0) {
  process.stdout.write(
    `    below the per-kind precision bar: ${belowBar
      .map((kind) => `${kind.kind} ${pct(kind.precision ?? 0)}`)
      .join(", ")}\n`,
  );
}
if (report.overall.kept_false_positive_rate >= 0.05) {
  process.stdout.write(
    `    false positives on kept promises: ${pct(report.overall.kept_false_positive_rate)} against a 5% limit\n`,
  );
}

if (report.mislabelled.length > 0) {
  process.stdout.write(
    `\n  ${report.mislabelled.length} case(s) whose observable label disagrees with measured coverage:\n`,
  );
  for (const outcome of report.mislabelled) {
    process.stdout.write(
      `    ${outcome.id}  observable=${outcome.observable}  coverage=${outcome.coverage?.toFixed(2)}\n`,
    );
  }
}

process.stdout.write(`\n  written to ${writeReport("breach", report)}\n`);
