import {
  containsInstant,
  type Detection,
  type Evidence,
  type Instant,
  isPriceObserved,
  type Money,
  type OwedPromise,
  subtractMoney,
} from "@owed/domain";
import type { ClaimMessage } from "@owed/recourse-protocol";
import { openingAsk, type RemedyBounds } from "./negotiator.js";

/**
 * What a remedy calculation needs beyond the clause itself.
 *
 * Structurally matches the policy library's `RemedyContext`, declared here so core keeps
 * no dependency on a package that reads the filesystem.
 */
export interface RemedyContext {
  amount_at_stake?: Money;
  /** How far a price fell, for price-match remedies. */
  shortfall?: Money;
}

/**
 * Derive what a remedy needs from the promise and what was observed.
 *
 * A price match pays back the difference, so the figure has to come from an actual
 * observed price rather than an assumption about how far prices fall.
 */
export function remedyContextFor(
  promise: OwedPromise,
  evidence: readonly Evidence[],
): RemedyContext {
  const paid = promise.amount_at_stake;
  if (paid === undefined) return {};

  if (promise.kind !== "price_match" || promise.window === undefined) {
    return { amount_at_stake: paid };
  }

  const window = promise.window;
  const cheapest = evidence
    .filter(isPriceObserved)
    .filter((item) => containsInstant(window, item.captured_at))
    .reduce<Money | undefined>(
      (lowest, item) =>
        lowest === undefined || item.amount.minor < lowest.minor ? item.amount : lowest,
      undefined,
    );

  if (cheapest === undefined || cheapest.minor >= paid.minor) return { amount_at_stake: paid };
  return { amount_at_stake: paid, shortfall: subtractMoney(paid, cheapest) };
}

export interface BuildClaimInput {
  claimId: string;
  at: Instant;
  promise: OwedPromise;
  detection: Detection;
  evidence: readonly Evidence[];
  bounds: RemedyBounds;
}

function uriOf(item: Evidence): string | undefined {
  return "uri" in item && typeof item.uri === "string" ? item.uri : undefined;
}

/**
 * Compose the opening CLAIM.
 *
 * The evidence pack carries only what the detection actually relied on, together with
 * the coverage and the interval it was measured over — so a merchant can see exactly
 * how much of the relevant window was observed before deciding what to pay.
 */
export function buildClaim({
  claimId,
  at,
  promise,
  detection,
  evidence,
  bounds,
}: BuildClaimInput): ClaimMessage {
  const cited = new Set(detection.evidence_ids);
  const items = evidence
    .filter((item) => cited.has(item.id))
    .map((item) => {
      const uri = uriOf(item);
      return {
        id: item.id,
        kind: item.kind,
        captured_at: item.captured_at,
        ...(uri === undefined ? {} : { uri }),
      };
    });

  return {
    type: "CLAIM",
    claim_id: claimId,
    at,
    promise: {
      id: promise.id,
      kind: promise.kind,
      merchant: promise.merchant,
      made_at: promise.made_at,
      source_ref: promise.source_ref,
      ...(promise.window === undefined ? {} : { window: promise.window }),
      ...(promise.deadline === undefined ? {} : { deadline: promise.deadline }),
      ...(promise.amount_at_stake === undefined
        ? {}
        : { amount_at_stake: promise.amount_at_stake }),
    },
    breach_kind: detection.kind,
    evidence_pack: {
      items,
      coverage: detection.coverage,
      evaluation_interval: detection.evaluation_interval,
    },
    policy_ref: bounds.clause.id,
    // The most the merchant's own wording allows, and never more.
    ask: openingAsk(bounds),
  };
}
