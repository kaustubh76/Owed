import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runRecourseMatrix } from "../recourse.js";

const report = await runRecourseMatrix();
const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
const usd = (minor: number) => `$${(minor / 100).toFixed(2)}`;

process.stdout.write(`
Recourse evaluation
  grid              ${report.grid_size} merchant policies x ${report.breach_kinds} breach kinds = ${report.sessions} sessions
  owed (denominator) ${usd(report.totals.owed_minor)}   — what the merchants' own policies say they owe

  do nothing        ${usd(report.totals.do_nothing_minor)}  (0.0%)
  accept 1st offer  ${usd(report.totals.accept_first_offer_minor)}  (${pct(report.totals.accept_first_offer_share)})
  negotiator        ${usd(report.totals.negotiator_minor)}  (${pct(report.totals.negotiator_share)})
  lift over baseline ${report.totals.lift.toFixed(2)}x
  median rounds     ${report.median_rounds}

  cells where taking the first offer would have been better: ${report.losses.length} (${pct(report.loss_rate)})
  cells no strategy could recover from:                      ${report.unwinnable}

  conditional readings
    excluding merchants that punish a counter   ${pct(report.non_adversarial.negotiator_share)} vs ${pct(report.non_adversarial.accept_first_offer_share)}  (${report.non_adversarial.lift.toFixed(2)}x)
    merchants that engaged at all               ${pct(report.engaged.negotiator_share)} vs ${pct(report.engaged.accept_first_offer_share)}  (${report.engaged.lift.toFixed(2)}x)

  by breach kind
`);
for (const [kind, totals] of Object.entries(report.by_breach_kind)) {
  process.stdout.write(
    `    ${kind.padEnd(18)} ${pct(totals.negotiator_share).padStart(6)}  vs first offer ${pct(totals.accept_first_offer_share).padStart(6)}\n`,
  );
}

const out = fileURLToPath(new URL("../../../results/recourse.json", import.meta.url));
mkdirSync(fileURLToPath(new URL("../../../results/", import.meta.url)), { recursive: true });
writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`\n  written to eval/results/recourse.json\n`);
