import type { MerchantBehaviour } from "./behaviour.js";

/**
 * The pre-registered parameter space.
 *
 * Chosen to span plausible merchant conduct — from paying in full on request to
 * punishing anyone who argues — and fixed before the negotiator was tuned against it.
 * The full cross product is run rather than a sample: these are pure functions costing
 * microseconds, so there is no reason to report a subset and every reason not to.
 */
export const GRID_PARAMETERS = {
  anchor_ratio: [0, 0.25, 0.4, 0.65, 1],
  concession_rate: [0, 0.3, 0.6],
  accept_ratio: [0.8, 1, 1.2],
  declines_at_round: [0, 1, 2],
  withdraws_on_counter: [false, true],
} as const;

export const GRID_SIZE =
  GRID_PARAMETERS.anchor_ratio.length *
  GRID_PARAMETERS.concession_rate.length *
  GRID_PARAMETERS.accept_ratio.length *
  GRID_PARAMETERS.declines_at_round.length *
  GRID_PARAMETERS.withdraws_on_counter.length;

/** A stable name, so a result can be traced back to the exact policy that produced it. */
export function behaviourId(behaviour: MerchantBehaviour): string {
  return [
    `a${behaviour.anchor_ratio}`,
    `c${behaviour.concession_rate}`,
    `t${behaviour.accept_ratio}`,
    `d${behaviour.declines_at_round}`,
    behaviour.withdraws_on_counter ? "w1" : "w0",
  ].join("-");
}

/** Deterministic: the same order on every run, which is what makes the grid citable. */
export function generateGrid(): MerchantBehaviour[] {
  const grid: MerchantBehaviour[] = [];
  for (const anchor_ratio of GRID_PARAMETERS.anchor_ratio) {
    for (const concession_rate of GRID_PARAMETERS.concession_rate) {
      for (const accept_ratio of GRID_PARAMETERS.accept_ratio) {
        for (const declines_at_round of GRID_PARAMETERS.declines_at_round) {
          for (const withdraws_on_counter of GRID_PARAMETERS.withdraws_on_counter) {
            grid.push({
              anchor_ratio,
              concession_rate,
              accept_ratio,
              declines_at_round,
              withdraws_on_counter,
            });
          }
        }
      }
    }
  }
  return grid;
}
