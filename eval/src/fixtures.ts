import type { RemedyBounds } from "@owed/core";
import { type BreachKind, type MerchantPolicy, type Money, remedyFor } from "@owed/policy-library";
import type { ClaimMessage } from "@owed/recourse-protocol";

/** Shared by the single-shot and repeat-game evaluations so both measure the same thing. */

export const BREACH_KINDS: readonly BreachKind[] = [
  "late_eta",
  "missed_window",
  "phantom_delivery",
  "no_show",
  "late_refund",
  "price_drop",
];

/** A price drop needs a figure to work from; the rest are fixed remedies. */
export const PRICE_SHORTFALL: Money = { minor: 1500, currency: "USD" };

export interface RemedyBoundsFor {
  merchant: string;
  breach_kind: BreachKind;
  bounds: RemedyBounds;
}

/**
 * The first merchant publishing a remedy for this breach.
 *
 * Which merchant it is does not matter to the result: every figure is normalised by that
 * merchant's own published remedy, so the comparison is between strategies rather than
 * between price lists.
 */
export function boundsForBreachKind(
  policies: readonly MerchantPolicy[],
  breachKind: BreachKind,
): RemedyBoundsFor | undefined {
  for (const policy of policies) {
    const remedy = remedyFor(policy, breachKind, { shortfall: PRICE_SHORTFALL });
    if (remedy === undefined) continue;
    return {
      merchant: policy.merchant,
      breach_kind: breachKind,
      bounds: {
        reservation: remedy.reservation,
        ceiling: remedy.ceiling,
        clause: { id: remedy.clause.id, title: remedy.clause.title },
      },
    };
  }
  return undefined;
}

export function claimFor(resolved: RemedyBoundsFor, ask: Money): ClaimMessage {
  return {
    type: "CLAIM",
    claim_id: `clm_${resolved.breach_kind}`,
    at: "2026-01-02T18:00:00.000Z",
    promise: {
      id: `prm_${resolved.breach_kind}`,
      kind: "delivery_window",
      merchant: resolved.merchant,
      made_at: "2026-01-01T00:00:00.000Z",
      amount_at_stake: { minor: 6840, currency: ask.currency },
    },
    breach_kind: resolved.breach_kind,
    evidence_pack: {
      items: [{ id: "evd_1", kind: "carrier_scan", captured_at: "2026-01-02T14:12:00.000Z" }],
      coverage: 0.82,
      evaluation_interval: {
        start: "2026-01-02T13:42:00.000Z",
        end: "2026-01-02T14:42:00.000Z",
      },
    },
    policy_ref: resolved.bounds.clause.id,
    ask,
  };
}
