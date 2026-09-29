import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { generateBreachCorpus } from "../breach/corpus.js";
import { measureBreachDetection } from "../breach/measure.js";

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

const met =
  (report.overall.precision ?? 0) >= 0.9 && report.overall.kept_false_positive_rate < 0.05;
process.stdout.write(
  `\n  H2 (>= 0.9 precision per kind, < 5% false positives on kept): ${met ? "met" : "NOT met"}\n`,
);

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

const dir = fileURLToPath(new URL("../../results/", import.meta.url));
mkdirSync(dir, { recursive: true });
writeFileSync(`${dir}breach.json`, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write("\n  written to eval/results/breach.json\n");
