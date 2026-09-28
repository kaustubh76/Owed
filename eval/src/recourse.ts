import { createNegotiator, openingAsk } from "@owed/core";
import {
  behaviourId,
  createMerchantAgent,
  generateGrid,
  type MerchantBehaviour,
} from "@owed/merchant-agents";
import {
  type BreachKind,
  builtinPolicies,
  type MerchantPolicy,
  type Money,
  remedyFor,
} from "@owed/policy-library";
import { type ClaimMessage, firstOffer, runSession } from "@owed/recourse-protocol";

/**
 * The recourse evaluation.
 *
 * Every merchant in the pre-registered grid argues every breach kind against the
 * negotiator. The grid is the full cross product rather than a sample, and it includes
 * merchants that punish a counter — so the negotiator can, and does, lose.
 */

const BREACH_KINDS: readonly BreachKind[] = [
  "late_eta",
  "missed_window",
  "phantom_delivery",
  "no_show",
  "late_refund",
  "price_drop",
];

/** A price drop needs a figure to work from; the rest are fixed remedies. */
const PRICE_SHORTFALL: Money = { minor: 1500, currency: "USD" };

export interface Cell {
  behaviour_id: string;
  breach_kind: BreachKind;
  merchant: string;
  /** What the merchant's own policy says they owe — the denominator. */
  owed_minor: number;
  settled_minor: number;
  /** What "accept the first offer" would have recovered. */
  first_offer_minor: number;
  /** Whether any offer was made. An offer of zero still counts as engaging. */
  offered: boolean;
  outcome: "settled" | "escalated";
  rounds: number;
}

export interface Totals {
  owed_minor: number;
  negotiator_minor: number;
  accept_first_offer_minor: number;
  do_nothing_minor: number;
  negotiator_share: number;
  accept_first_offer_share: number;
  /** How much better than taking the first offer. 1 means no better. */
  lift: number;
}

export interface MatrixReport {
  currency: string;
  grid_size: number;
  breach_kinds: number;
  sessions: number;
  totals: Totals;
  by_breach_kind: Record<string, Totals>;
  /** Cells where taking the first offer would have beaten negotiating. */
  losses: Cell[];
  loss_rate: number;
  /** The same totals over the non-adversarial subset, for comparison. */
  non_adversarial: Totals;
  /**
   * Cells where the merchant made any offer at all.
   *
   * A third of the grid refuses outright on its first reply, so those claims are
   * unrecoverable by any strategy and drag both the negotiator and the baseline down
   * equally. Reporting the conditional figure alongside the unconditional one is the
   * only way to read either honestly.
   *
   * An offer of zero counts as engaging: those are precisely the cells where accepting
   * the first offer recovers nothing and negotiating recovers the published remedy, so
   * excluding them would quietly discard the negotiator's best cases.
   */
  engaged: Totals;
  /** Cells no strategy could have recovered anything from. */
  unwinnable: number;
  median_rounds: number;
}

function findRemedy(policies: MerchantPolicy[], breachKind: BreachKind) {
  for (const policy of policies) {
    const remedy = remedyFor(policy, breachKind, { shortfall: PRICE_SHORTFALL });
    if (remedy) return { policy, remedy };
  }
  return undefined;
}

function claimFor(
  merchant: string,
  breachKind: BreachKind,
  ask: Money,
  clauseId: string,
): ClaimMessage {
  return {
    type: "CLAIM",
    claim_id: `clm_${breachKind}`,
    at: "2026-01-02T18:00:00.000Z",
    promise: {
      id: `prm_${breachKind}`,
      kind: "delivery_window",
      merchant,
      made_at: "2026-01-01T00:00:00.000Z",
      amount_at_stake: { minor: 6840, currency: ask.currency },
    },
    breach_kind: breachKind,
    evidence_pack: {
      items: [{ id: "evd_1", kind: "carrier_scan", captured_at: "2026-01-02T14:12:00.000Z" }],
      coverage: 0.82,
      evaluation_interval: {
        start: "2026-01-02T13:42:00.000Z",
        end: "2026-01-02T14:42:00.000Z",
      },
    },
    policy_ref: clauseId,
    ask,
  };
}

function totalsOf(cells: readonly Cell[]): Totals {
  const owed = cells.reduce((sum, cell) => sum + cell.owed_minor, 0);
  const negotiator = cells.reduce((sum, cell) => sum + cell.settled_minor, 0);
  const acceptFirst = cells.reduce((sum, cell) => sum + cell.first_offer_minor, 0);
  return {
    owed_minor: owed,
    negotiator_minor: negotiator,
    accept_first_offer_minor: acceptFirst,
    do_nothing_minor: 0,
    negotiator_share: owed === 0 ? 0 : negotiator / owed,
    accept_first_offer_share: owed === 0 ? 0 : acceptFirst / owed,
    lift: acceptFirst === 0 ? (negotiator === 0 ? 1 : 0) : negotiator / acceptFirst,
  };
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2
    : (sorted[middle] as number);
}

export async function runRecourseMatrix(
  grid: readonly MerchantBehaviour[] = generateGrid(),
): Promise<MatrixReport> {
  const policies = builtinPolicies().all();
  const cells: Cell[] = [];

  for (const behaviour of grid) {
    for (const breachKind of BREACH_KINDS) {
      const found = findRemedy(policies, breachKind);
      if (found === undefined) continue;

      const { policy, remedy } = found;
      const bounds = {
        reservation: remedy.reservation,
        ceiling: remedy.ceiling,
        clause: { id: remedy.clause.id, title: remedy.clause.title },
      };

      const claim = claimFor(policy.merchant, breachKind, openingAsk(bounds), remedy.clause.id);
      const negotiator = { ...createNegotiator({ bounds }), open: () => claim };
      const agent = createMerchantAgent({
        config: { merchant: policy.merchant, behaviour },
        lookup: () => ({ stated: remedy.reservation, clause_title: remedy.clause.title }),
      });

      const session = await runSession(negotiator, agent);

      cells.push({
        behaviour_id: behaviourId(behaviour),
        breach_kind: breachKind,
        merchant: policy.merchant,
        owed_minor: remedy.reservation.minor,
        settled_minor: session.settled?.minor ?? 0,
        first_offer_minor: firstOffer(session.transcript)?.amount.minor ?? 0,
        offered: firstOffer(session.transcript) !== undefined,
        outcome: session.outcome,
        rounds: session.rounds,
      });
    }
  }

  const losses = cells.filter((cell) => cell.first_offer_minor > cell.settled_minor);
  const byBreachKind: Record<string, Totals> = {};
  for (const breachKind of BREACH_KINDS) {
    const subset = cells.filter((cell) => cell.breach_kind === breachKind);
    if (subset.length > 0) byBreachKind[breachKind] = totalsOf(subset);
  }

  return {
    currency: "USD",
    grid_size: grid.length,
    breach_kinds: BREACH_KINDS.length,
    sessions: cells.length,
    totals: totalsOf(cells),
    by_breach_kind: byBreachKind,
    losses,
    loss_rate: cells.length === 0 ? 0 : losses.length / cells.length,
    non_adversarial: totalsOf(cells.filter((cell) => !cell.behaviour_id.endsWith("w1"))),
    engaged: totalsOf(cells.filter((cell) => cell.offered)),
    unwinnable: cells.filter((cell) => !cell.offered && cell.settled_minor === 0).length,
    median_rounds: median(cells.filter((c) => c.outcome === "settled").map((c) => c.rounds)),
  };
}
