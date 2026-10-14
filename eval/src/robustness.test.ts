import { SeededRng } from "@owed/core";
import { VARIABLE_PARAMETERS, varyBehaviour } from "@owed/merchant-agents";
import { describe, expect, it } from "vitest";
import { runRecourseMatrix } from "./recourse.js";

/**
 * Merchants that do not behave exactly as configured.
 *
 * `Rng` and `SeededRng` have existed in `core/src/time/determinism.ts` since early on,
 * with the comment "randomness, injected so merchant-agent behaviour is reproducible",
 * and nothing ever injected one. The merchants were perfectly predictable, which
 * `eval/README.md` has carried as a caveat on every H3 figure: the negotiator reaching
 * the oracle is partly a property of the simulation.
 *
 * The first property below is the one that protects everything else in the repository:
 * the pre-registered run has to be untouched. Every published figure comes from it.
 */

const BEHAVIOUR = {
  anchor_ratio: 0.4,
  concession_rate: 0.3,
  accept_ratio: 1,
  declines_at_round: 0,
  withdraws_on_counter: false,
} as const;

describe("varying a merchant's temperament", () => {
  it("leaves the discrete parameters alone, whatever the jitter", () => {
    // These decide how much of the grid is adversarial or unwinnable, which is a
    // pre-registered property of the grid rather than one merchant's temperament.
    const varied = varyBehaviour(BEHAVIOUR, { rng: new SeededRng(7), jitter: 0.9 });

    expect(varied.declines_at_round).toBe(BEHAVIOUR.declines_at_round);
    expect(varied.withdraws_on_counter).toBe(BEHAVIOUR.withdraws_on_counter);
  });

  it("keeps every ratio non-negative, even when the jitter exceeds one", () => {
    for (let seed = 1; seed <= 20; seed += 1) {
      const varied = varyBehaviour(BEHAVIOUR, { rng: new SeededRng(seed), jitter: 2 });
      for (const parameter of VARIABLE_PARAMETERS) {
        expect(varied[parameter], `seed ${seed} ${parameter}`).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("gives the same temperament for the same seed, and a different one otherwise", () => {
    const once = varyBehaviour(BEHAVIOUR, { rng: new SeededRng(3), jitter: 0.25 });
    const again = varyBehaviour(BEHAVIOUR, { rng: new SeededRng(3), jitter: 0.25 });
    const elsewhere = varyBehaviour(BEHAVIOUR, { rng: new SeededRng(4), jitter: 0.25 });

    expect(again).toStrictEqual(once);
    expect(elsewhere).not.toStrictEqual(once);
  });

  it("changes nothing at all when the jitter is zero", () => {
    expect(varyBehaviour(BEHAVIOUR, { rng: new SeededRng(5), jitter: 0 })).toStrictEqual(BEHAVIOUR);
  });

  /**
   * Varying one parameter must not move the others' draws.
   *
   * Otherwise two arms of the decomposition would differ for two reasons at once and
   * neither could be attributed — which is the whole purpose of running them one at a
   * time. `varyBehaviour` draws for all three regardless and uses only the chosen ones.
   */
  it("draws for every parameter even when only one is varied", () => {
    const all = varyBehaviour(BEHAVIOUR, { rng: new SeededRng(11), jitter: 0.25 });
    for (const parameter of VARIABLE_PARAMETERS) {
      const alone = varyBehaviour(BEHAVIOUR, {
        rng: new SeededRng(11),
        jitter: 0.25,
        parameters: [parameter],
      });

      expect(alone[parameter], parameter).toBe(all[parameter]);
      for (const other of VARIABLE_PARAMETERS) {
        if (other !== parameter) expect(alone[other], other).toBe(BEHAVIOUR[other]);
      }
    }
  });
});

describe("the pre-registered run, which every published figure comes from", () => {
  /**
   * The property that matters most in this file. An optional seam that changed the default
   * would have quietly moved H3's numbers, and the README quotes them.
   */
  it("is byte-identical whether or not the variability seam exists", async () => {
    const [plain, explicitlyNone] = await Promise.all([
      runRecourseMatrix(),
      runRecourseMatrix(undefined, {}),
    ]);

    expect(explicitlyNone).toStrictEqual(plain);
  });

  it("still reports the figures the README quotes", async () => {
    const report = await runRecourseMatrix();

    // 33.9% at 1.10x, median two rounds — §10 and eval/README.md.
    expect(report.totals.negotiator_share).toBeCloseTo(0.339, 3);
    expect(report.totals.lift).toBeCloseTo(1.103, 3);
    expect(report.median_rounds).toBe(2);
    expect(report.grid_size).toBe(270);
    expect(report.sessions).toBe(1620);
  });
});

describe("what variability does to the result", () => {
  /**
   * The measured headline, pinned at one seed so a regression in the seam shows up here
   * rather than only in a harness nobody runs. The full decomposition across five seeds
   * and two jitters is `pnpm --filter @owed/eval robustness`.
   */
  it("costs the negotiator its lead once the acceptance threshold moves", async () => {
    const report = await runRecourseMatrix(undefined, {
      variability: { rng: new SeededRng(1), jitter: 0.25, parameters: ["accept_ratio"] },
    });

    expect(report.totals.lift).toBeLessThan(1.103);
    expect(report.totals.negotiator_share).toBeLessThan(0.339);
  });

  /**
   * And the parameter that turns out barely to matter, which is as much of a finding.
   *
   * The negotiator counters at the reservation on its first reply, so how fast a merchant
   * would have conceded over later rounds almost never comes into it. "Barely" rather than
   * "not at all": it moves the share by about two hundredths of a percentage point, which
   * the harness's one-decimal output rounds away. Compared against the deterministic run
   * in the same test rather than a constant, so this says *unmoved relative to the
   * baseline* and not *equal to a number somebody typed*.
   */
  it("is barely moved by how quickly merchants concede", async () => {
    const [deterministic, varied] = await Promise.all([
      runRecourseMatrix(),
      runRecourseMatrix(undefined, {
        variability: { rng: new SeededRng(1), jitter: 0.25, parameters: ["concession_rate"] },
      }),
    ]);

    const moved = Math.abs(varied.totals.negotiator_share - deterministic.totals.negotiator_share);
    expect(moved).toBeLessThan(0.001);
    expect(varied.totals.lift).toBeGreaterThan(1.1);
  });
});
