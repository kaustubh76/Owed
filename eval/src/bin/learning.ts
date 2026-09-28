import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runLearningMatrix } from "../learning.js";

const report = await runLearningMatrix();
const pct = (value: number) => `${(value * 100).toFixed(1)}%`;

process.stdout.write(`
Learning evaluation
  ${report.grid_size} merchant policies x ${report.cells / report.grid_size} breach kinds, ${report.episodes} episodes each

  accept 1st offer   ${pct(report.accept_first_offer.share)}
  cold negotiator    ${pct(report.cold.share)}
  learner, episode 1 ${pct(report.first_episode.share)}   ← must equal cold, or it is cheating
  learner, settled   ${pct(report.last_episode.share)}
  oracle (knows type) ${pct(report.oracle.share)}

  advantage captured ${pct(report.advantage_captured)}  of what perfect information would give
  loss rate  cold ${pct(report.cold_loss_rate)}  ->  learned ${pct(report.learned_loss_rate)}

  learning curve
`);
for (const point of report.learning_curve) {
  if (point.episode > 8 && point.episode < report.episodes) continue;
  const bar = "#".repeat(Math.round(point.share * 60));
  process.stdout.write(
    `    ${String(point.episode).padStart(2)}  ${pct(point.share).padStart(6)}  ${bar}\n`,
  );
}

const dir = fileURLToPath(new URL("../../../results/", import.meta.url));
mkdirSync(dir, { recursive: true });
writeFileSync(`${dir}learning.json`, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write("\n  written to eval/results/learning.json\n");
