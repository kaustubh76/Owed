import { claimRoundCount, coverageGaps, type LedgerState } from "@owed/core";
import type { Claim, ClaimView, EvidenceView } from "@owed/domain";
import { NotFoundError, requirePromise, type ToolContext } from "./context.js";

function uriOf(item: { uri?: string }): string | undefined {
  return typeof item.uri === "string" ? item.uri : undefined;
}

function detailOf(item: {
  kind: string;
  status?: string;
  event?: string;
  label?: string;
}): string | undefined {
  return item.status ?? item.event ?? item.label;
}

/**
 * What was and was not seen about one promise.
 *
 * The gaps are computed rather than described: `coverageGaps` returns the stretches
 * nobody was watching, so the card can name them instead of rounding them away.
 */
export function evidenceViewFor(
  context: ToolContext,
  promiseId: string,
  onlyEvidenceId?: string,
): EvidenceView {
  const view = requirePromise(context, promiseId);
  const assessment = view.assessment;

  /**
   * The gaps this verdict was reached in spite of — and no others.
   *
   * Read from the detection's own `observed`, never from the household's camera
   * timeline. Those are not the same thing: a missed window settled by a carrier scan
   * has full coverage whatever the camera was doing, and drawing the camera's gaps
   * underneath it put "watched 100% of the window" directly above four hours of
   * "not watched" on the same card.
   */
  const gaps =
    assessment === undefined
      ? []
      : coverageGaps(assessment.observed, assessment.evaluation_interval);

  const items = view.evidence
    .filter((item) => onlyEvidenceId === undefined || item.id === onlyEvidenceId)
    .map((item) => {
      const uri = uriOf(item as { uri?: string });
      const detail = detailOf(item as { kind: string });
      return {
        evidence_id: item.id,
        kind: item.kind,
        captured_at: item.captured_at,
        ...(uri === undefined ? {} : { uri }),
        ...(detail === undefined ? {} : { detail }),
      };
    });

  if (onlyEvidenceId !== undefined && items.length === 0) {
    throw new NotFoundError(`No evidence ${onlyEvidenceId} in this ledger.`);
  }

  return {
    promise_id: view.promise.id,
    merchant: view.promise.merchant,
    kind: view.promise.kind,
    status: view.status,
    ...(assessment === undefined
      ? {}
      : {
          verdict: assessment.verdict,
          coverage: assessment.coverage,
          evaluation_interval: assessment.evaluation_interval,
          explanation: assessment.explanation,
        }),
    gaps,
    items,
  };
}

export function claimViewFor(claim: Claim): ClaimView {
  return {
    claim_id: claim.id,
    promise_id: claim.promise_id,
    merchant: claim.merchant,
    state: claim.state,
    ask: claim.ask,
    expected: claim.expected,
    ...(claim.settled_amount === undefined ? {} : { settled_amount: claim.settled_amount }),
    ...(claim.recovered_amount === undefined ? {} : { recovered_amount: claim.recovered_amount }),
    rounds: claim.rounds,
    round_count: claimRoundCount(claim),
  };
}

/** The evidence view a promise with no claim still deserves. */
export function findClaimForPromise(state: LedgerState, promiseId: string): Claim | undefined {
  const claimId = state.promises.get(promiseId)?.claim_id;
  return claimId === undefined ? undefined : state.claims.get(claimId);
}
