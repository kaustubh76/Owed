import type { EvidenceStance } from "@owed/domain";

/**
 * What the evidence card calls each stance.
 *
 * Keyed by `EvidenceStance`, not by `Verdict`, and in a labels module rather than inside the
 * component — the same shape as `ledger/labels.ts`, and for the same two reasons the index
 * gives: a host-facing label set is reusable as code, and a map keyed by the domain's own
 * union makes a missing case a compile error instead of a card rendering `undefined`.
 *
 * `Unwatched` is the case this card got wrong. With no verdict it rendered `Undetermined` —
 * "still watching" — which is right for a promise whose moment of judgement has not come and
 * false for one nothing will ever judge. A tracked warranty read out of "Covered for 24
 * months under our manufacturer warranty." is the second: nothing in the home could settle
 * it, and it has no sibling promise to inherit a verdict from. The spoken line was corrected
 * first and this map was not, while `docs/contract-v1.md` said both read the one field — so
 * the two disagreed, in the direction that overstates what Owed is doing.
 */
export const STANCE_LABEL: Readonly<Record<EvidenceStance, string>> = {
  Kept: "kept",
  Suspected: "not enough to claim",
  Breached: "broken",
  Undetermined: "still watching",
  Unwatched: "not watched",
};

/** The reason shown where there is no coverage bar, because nothing was ever evaluated. */
export const UNWATCHED_REASON =
  "Recorded, but nothing the home sees would show whether they keep it.";
