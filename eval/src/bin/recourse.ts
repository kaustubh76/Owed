import { runRecourseMatrix } from "../recourse.js";
import { writeReport } from "../results.js";

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

/**
 * H3 as pre-registered, which until now this harness computed every input for and never
 * stated.
 *
 * `product_ideation.md:162`: "The negotiator recovers >= 60% of owed value across the
 * matrix, >= 1.5x the 'accept first offer' baseline, with median <= 2 rounds." Three
 * criteria. This file printed all three figures and no verdict, so H3's met/not-met lived
 * only in prose — which is exactly how it drifted into being reported as a flat "not met"
 * when one of the three is satisfied, and how the demo script came to tell a reader to say
 * so on camera.
 *
 * `bin/extraction.ts` computes H1's and `bin/breach.ts` computes H2's. This completes the
 * set, so the README's claim that **all three** are "reported met or not" is computed
 * rather than asserted.
 */
const criteria = [
  {
    name: ">= 60% of owed value",
    ok: report.totals.negotiator_share >= 0.6,
    actual: pct(report.totals.negotiator_share),
  },
  {
    name: ">= 1.5x the accept-first-offer baseline",
    ok: report.totals.lift >= 1.5,
    actual: `${report.totals.lift.toFixed(2)}x`,
  },
  {
    name: "median <= 2 rounds",
    ok: report.median_rounds <= 2,
    actual: `${report.median_rounds}`,
  },
];
const failed = criteria.filter((criterion) => !criterion.ok);
process.stdout.write(
  `\n  H3 (>= 60% of owed, >= 1.5x baseline, median <= 2 rounds): ${
    failed.length === 0 ? "met" : "NOT met"
  }\n`,
);
for (const criterion of criteria) {
  process.stdout.write(
    `    ${criterion.ok ? "met    " : "NOT met"}  ${criterion.name.padEnd(42)} ${criterion.actual}\n`,
  );
}

process.stdout.write(`\n  written to ${writeReport("recourse", report)}\n`);
