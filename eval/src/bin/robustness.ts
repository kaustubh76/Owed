import { SeededRng } from "@owed/core";
import { generateGrid, VARIABLE_PARAMETERS } from "@owed/merchant-agents";
import { type MatrixReport, runRecourseMatrix } from "../recourse.js";
import { writeReport } from "../results.js";

/**
 * Does the H3 result survive merchants that do not behave exactly as configured?
 *
 * `eval/README.md` has carried the caveat for as long as there has been a number to
 * caveat: these merchants are deterministic, so the negotiator reaching the oracle is
 * partly a property of the simulation rather than a claim about the algorithm. This
 * measures how much of it is which, instead of restating the caveat.
 *
 * Each merchant's three continuous parameters — what it anchors at, how much of the gap it
 * closes, what it will accept — are multiplied by a draw from [1-j, 1+j], once per agent,
 * from `SeededRng`. `Rng` and `SeededRng` were written for this, with the comment
 * "injected so merchant-agent behaviour is reproducible", and until now nothing injected
 * one.
 *
 * **This does not replace the pre-registered run.** The grid is unchanged, the published
 * figures come from the deterministic pass, and the deterministic pass is run here too so
 * the two sit side by side. `declines_at_round` and `withdraws_on_counter` are left alone:
 * they decide how much of the grid is adversarial or unwinnable, which is a pre-registered
 * property of the grid and not a merchant's temperament.
 *
 * Seeds are fixed and listed, so this is reproducible rather than merely random.
 */

/** Arbitrary and fixed. Written down because an unlisted seed is not a reproducible one. */
const SEEDS = [1, 2, 3, 4, 5] as const;

/** 10% and 25% wobble. Enough to matter, not enough to be a different grid. */
const JITTERS = [0.1, 0.25] as const;

interface Pass {
  jitter: number;
  seed: number;
  negotiator_share: number;
  accept_first_offer_share: number;
  lift: number;
  median_rounds: number;
  loss_rate: number;
}

const summarise = (report: MatrixReport, jitter: number, seed: number): Pass => ({
  jitter,
  seed,
  negotiator_share: report.totals.negotiator_share,
  accept_first_offer_share: report.totals.accept_first_offer_share,
  lift: report.totals.lift,
  median_rounds: report.median_rounds,
  loss_rate: report.loss_rate,
});

const mean = (values: readonly number[]) =>
  values.reduce((total, value) => total + value, 0) / values.length;

/**
 * Which parameters each arm wobbles.
 *
 * All three together is the headline; one at a time is what makes the headline
 * attributable. `varyBehaviour` draws for all three regardless and uses only the chosen
 * ones, so the arms share a draw sequence and differ in one thing only.
 */
const ARMS = [
  { name: "all three", parameters: VARIABLE_PARAMETERS },
  ...VARIABLE_PARAMETERS.map((parameter) => ({ name: parameter, parameters: [parameter] })),
] as const;

const baseline = await runRecourseMatrix();
const passes: Array<Pass & { arm: string }> = [];
for (const arm of ARMS) {
  for (const jitter of JITTERS) {
    for (const seed of SEEDS) {
      const report = await runRecourseMatrix(undefined, {
        variability: { rng: new SeededRng(seed), jitter, parameters: arm.parameters },
      });
      passes.push({ ...summarise(report, jitter, seed), arm: arm.name });
    }
  }
}

const byArm = ARMS.flatMap((arm) =>
  JITTERS.map((jitter) => {
    const subset = passes.filter((pass) => pass.arm === arm.name && pass.jitter === jitter);
    const lifts = subset.map((pass) => pass.lift);
    return {
      arm: arm.name,
      jitter,
      runs: subset.length,
      mean_negotiator_share: mean(subset.map((pass) => pass.negotiator_share)),
      mean_lift: mean(lifts),
      min_lift: Math.min(...lifts),
      max_lift: Math.max(...lifts),
      /** The criterion that matters: does arguing still beat taking the first offer? */
      beats_baseline_in: subset.filter((pass) => pass.lift > 1).length,
      mean_median_rounds: mean(subset.map((pass) => pass.median_rounds)),
    };
  }),
);
const byJitter = byArm.filter((row) => row.arm === "all three");

/**
 * And the question the first version of this harness raised and did not answer.
 *
 * Having measured that the lift depends on merchants honouring their thresholds exactly,
 * `readme.md` §10 and `eval/README.md` both went on to predict that "countering a little
 * under the reservation would trade a little upside for a lot of robustness". That was
 * written and never run. It is run here, for both levers, because the prediction names the
 * one that breaks the product's stance and the other one was missed entirely:
 *
 * - `acceptMargin` — settle for slightly less rather than keep arguing. The negotiator
 *   still asks for the published figure, so the stance holds.
 * - `counterMargin` — ask for slightly less. This is what was predicted, and it undercuts
 *   the published figure, which `negotiator.test.ts` asserts it never does.
 *
 * The deterministic column is the **cost**: money left on the table against merchants who
 * would have paid in full. The jittered columns are the **benefit**. Nothing here changes a
 * default; both levers are zero everywhere except in these passes.
 */
const MARGINS = [0.025, 0.05, 0.1] as const;
const LEVERS = ["acceptMargin", "counterMargin"] as const;

interface MarginPass {
  lever: string;
  margin: number;
  jitter: number;
  negotiator_share: number;
  lift: number;
  beats_baseline: boolean;
}

const marginPasses: MarginPass[] = [];
for (const lever of LEVERS) {
  for (const margin of MARGINS) {
    // Deterministic: what giving ground costs when merchants behave exactly as configured.
    const exact = await runRecourseMatrix(undefined, { negotiator: { [lever]: margin } });
    marginPasses.push({
      lever,
      margin,
      jitter: 0,
      negotiator_share: exact.totals.negotiator_share,
      lift: exact.totals.lift,
      beats_baseline: exact.totals.lift > 1,
    });

    // And what it buys once their thresholds are uncertain, averaged over the same seeds.
    for (const jitter of JITTERS) {
      const runs = await Promise.all(
        SEEDS.map((seed) =>
          runRecourseMatrix(undefined, {
            negotiator: { [lever]: margin },
            variability: { rng: new SeededRng(seed), jitter, parameters: VARIABLE_PARAMETERS },
          }),
        ),
      );
      marginPasses.push({
        lever,
        margin,
        jitter,
        negotiator_share: mean(runs.map((r) => r.totals.negotiator_share)),
        lift: mean(runs.map((r) => r.totals.lift)),
        beats_baseline: runs.every((r) => r.totals.lift > 1),
      });
    }
  }
}

const report = {
  what: "H3 under merchants that do not behave exactly as configured",
  grid_size: baseline.grid_size,
  breach_kinds: baseline.breach_kinds,
  sessions_per_pass: baseline.sessions,
  seeds: [...SEEDS],
  jitters: [...JITTERS],
  varied: [...VARIABLE_PARAMETERS],
  held_fixed: ["declines_at_round", "withdraws_on_counter"],
  deterministic: summarise(baseline, 0, 0),
  /**
   * Why `accept_ratio` is the parameter that decides this.
   *
   * The negotiator counters at exactly the reservation, and a merchant settles when the
   * counter is at or below `stated × accept_ratio` — where `stated` *is* the reservation.
   * So a third of the grid settles at exact equality, to the penny. Wobble that threshold
   * down and those cells refuse instead of settling at the full published figure; wobble
   * it up and nothing improves, because the negotiator never asks for more than the
   * reservation. The effect is one-sided by construction.
   */
  knife_edge: {
    grid_size: baseline.grid_size,
    accept_ratio_exactly_one: generateGrid().filter((behaviour) => behaviour.accept_ratio === 1)
      .length,
    comparison: "counter <= stated * accept_ratio, with counter === stated",
  },
  by_arm: byArm,
  passes,
  /** The prediction `readme.md` §10 made and had not measured. */
  conceding: {
    levers: [...LEVERS],
    margins: [...MARGINS],
    note: "jitter 0 is the pre-registered grid: what conceding costs when nobody wobbles.",
    passes: marginPasses,
  },
};

const pct = (value: number) => `${(value * 100).toFixed(1)}%`;

process.stdout.write(`
Robustness of H3 to merchant variability
  grid                ${report.grid_size} policies x ${report.breach_kinds} breach kinds = ${report.sessions_per_pass} sessions per pass
  varied              ${report.varied.join(", ")}
  held fixed          ${report.held_fixed.join(", ")}
  seeds               ${report.seeds.join(", ")}

  deterministic (the pre-registered run, and where every published figure comes from)
    negotiator        ${pct(report.deterministic.negotiator_share)}   lift ${report.deterministic.lift.toFixed(2)}x   median rounds ${report.deterministic.median_rounds}

`);
for (const row of byArm) {
  process.stdout.write(
    `  varying ${row.arm.padEnd(16)} at jitter ${String(row.jitter).padEnd(5)} over ${row.runs} seeds\n` +
      `    negotiator        ${pct(row.mean_negotiator_share)}   lift ${row.mean_lift.toFixed(2)}x  (${row.min_lift.toFixed(2)}x to ${row.max_lift.toFixed(2)}x)\n` +
      `    beat the baseline ${row.beats_baseline_in} of ${row.runs} runs\n`,
  );
}

/**
 * The claim this harness is allowed to make.
 *
 * Not H3's thresholds — those are measured by `recourse` and `learning` on the
 * deterministic grid, and nothing here changes them. This one asks only whether the
 * direction of the result is an artefact of the merchants being predictable.
 */
const robust = byJitter.every((row) => row.beats_baseline_in === row.runs);
process.stdout.write(
  `\n  ${report.knife_edge.accept_ratio_exactly_one} of ${report.knife_edge.grid_size} policies accept at exactly the counter` +
    " — the negotiator asks for the\n  reservation and a third of the grid settles at precisely that figure, so wobbling the\n" +
    "  acceptance threshold is one-sided: it can only cost.\n",
);

process.stdout.write(
  robust
    ? "\n  Arguing still beat taking the first offer in every run, at every jitter: the\n  direction of the H3 result is not an artefact of deterministic merchants.\n"
    : "\n  Arguing did NOT beat taking the first offer in every run. The direction of the H3\n  result depends on merchants behaving as configured, and the README must say so.\n",
);

process.stdout.write("\n  does conceding a little buy robustness? (the prediction §10 made)\n");
for (const lever of LEVERS) {
  process.stdout.write(`\n    ${lever}\n`);
  process.stdout.write("      margin   deterministic      jitter 0.1         jitter 0.25\n");
  for (const margin of MARGINS) {
    const cell = (jitter: number) => {
      const row = marginPasses.find(
        (pass) => pass.lever === lever && pass.margin === margin && pass.jitter === jitter,
      );
      return row === undefined
        ? "—".padEnd(18)
        : `${row.lift.toFixed(2)}x ${row.beats_baseline ? "  " : "<1"}`.padEnd(18);
    };
    process.stdout.write(
      `      ${`${(margin * 100).toFixed(1)}%`.padEnd(8)} ${cell(0)} ${cell(0.1)} ${cell(0.25)}\n`,
    );
  }
}
process.stdout.write(
  `\n      for comparison, conceding nothing: ${report.deterministic.lift.toFixed(2)}x deterministic, ` +
    `${(byJitter.find((row) => row.jitter === 0.1)?.mean_lift ?? 0).toFixed(2)}x at jitter 0.1, ` +
    `${(byJitter.find((row) => row.jitter === 0.25)?.mean_lift ?? 0).toFixed(2)}x at jitter 0.25\n`,
);

process.stdout.write(`\n  written to ${writeReport("robustness", report)}\n`);
