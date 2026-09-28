import {
  assessPromise,
  fileClaim,
  type IdGen,
  type RemedyBounds,
  remedyContextFor,
  SeededIdGen,
} from "@owed/core";
import type { Evidence, Instant, LedgerEvent, ObservationWindow, OwedPromise } from "@owed/domain";
import { createMerchantAgent, storyboardMerchant } from "@owed/merchant-agents";
import { type BreachKind, builtinPolicies, remedyFor } from "@owed/policy-library";
import type { ArcSpec } from "./types.js";

export const DOORBELL_SOURCE = "src_doorbell";

export function createIdGen(): IdGen {
  return new SeededIdGen();
}

/**
 * Scenario time and wall time are the same in seeded data: the whole point is that a
 * replay produces byte-identical state on every run.
 */
function envelope(idGen: IdGen, household_id: string, occurred_at: Instant) {
  return { id: idGen.next("evt"), household_id, occurred_at, recorded_at: occurred_at };
}

export function evidenceEvent(idGen: IdGen, household_id: string, evidence: Evidence): LedgerEvent {
  return {
    ...envelope(idGen, household_id, evidence.captured_at),
    type: "EvidenceObserved",
    evidence,
  };
}

export function uptimeEvent(
  idGen: IdGen,
  household_id: string,
  window: ObservationWindow,
): LedgerEvent {
  return {
    ...envelope(idGen, household_id, window.interval.start),
    type: "SourceUptimeRecorded",
    window,
  };
}

function observationWindows(household_id: string, arc: ArcSpec): ObservationWindow[] {
  return (arc.uptime ?? []).map((interval) => ({
    source_id: DOORBELL_SOURCE,
    household_id,
    interval,
  }));
}

/**
 * What the merchant's own published policy entitles this household to.
 *
 * Throws rather than inventing a figure: if a merchant publishes nothing covering a
 * breach, there is no claim to make, and the seed should not paper over the gap.
 */
function boundsFor(
  promise: OwedPromise,
  breachKind: BreachKind,
  evidence: readonly Evidence[],
): RemedyBounds {
  const policy = builtinPolicies().get(promise.merchant);
  if (policy === undefined) throw new Error(`no published policy for ${promise.merchant}`);

  const remedy = remedyFor(policy, breachKind, remedyContextFor(promise, evidence));
  if (remedy === undefined) {
    throw new Error(`${promise.merchant} publishes no remedy for ${breachKind}`);
  }

  return {
    reservation: remedy.reservation,
    ceiling: remedy.ceiling,
    clause: { id: remedy.clause.id, title: remedy.clause.title },
  };
}

/**
 * Expand one arc into its ledger events, in the order they occurred.
 *
 * Nothing here is asserted. The breach engine decides the verdict from the evidence, the
 * policy library supplies the figures from the merchant's own wording, and the
 * negotiation actually happens against a merchant agent — so the demo shows outcomes
 * rather than a script.
 */
export async function arcEvents(
  household_id: string,
  arc: ArcSpec,
  idGen: IdGen,
): Promise<LedgerEvent[]> {
  const uptime = observationWindows(household_id, arc);
  const evidence = arc.evidence ?? [];

  const events: LedgerEvent[] = [
    {
      ...envelope(idGen, household_id, arc.promise.made_at),
      type: "PromiseCaptured",
      promise: arc.promise,
    },
    ...uptime.map((window) => uptimeEvent(idGen, household_id, window)),
    ...evidence.map((item) => evidenceEvent(idGen, household_id, item)),
  ];

  const detection = assessPromise({
    promise: arc.promise,
    evidence,
    uptime,
    now: arc.assessed_at,
  });
  if (detection === undefined) {
    throw new Error(`no detector produced a verdict for ${arc.promise.id}`);
  }

  events.push({
    ...envelope(idGen, household_id, arc.assessed_at),
    type: "PromiseAssessed",
    assessment: { ...detection, id: idGen.next("brc"), detected_at: arc.assessed_at },
  });

  const claim = arc.claim;
  if (!claim) return events;

  const bounds = boundsFor(arc.promise, detection.kind, evidence);
  const config = storyboardMerchant(arc.promise.merchant);
  if (config === undefined) {
    throw new Error(`no merchant agent configured for ${arc.promise.merchant}`);
  }

  const filed = await fileClaim({
    householdId: household_id,
    claimId: claim.id,
    promise: arc.promise,
    detection,
    evidence,
    bounds,
    respondent: createMerchantAgent({
      config,
      lookup: () => ({ stated: bounds.reservation, clause_title: bounds.clause.title }),
    }),
    proposedAt: claim.proposed_at,
    filedAt: claim.filed_at,
    confirmedBy: claim.confirmed_by,
    idGen,
    ...(claim.attached_evidence_ids === undefined
      ? {}
      : { attachedEvidenceIds: claim.attached_evidence_ids }),
    ...(claim.reply_interval_ms === undefined ? {} : { replyIntervalMs: claim.reply_interval_ms }),
    ...(claim.recovered_at === undefined ? {} : { recoveredAt: claim.recovered_at }),
    ...(claim.coverage_statement === undefined
      ? {}
      : { coverageStatement: claim.coverage_statement }),
  });

  events.push(...filed.events);
  return events;
}

/** Ledger events must be replayed in `occurred_at` order regardless of authoring order. */
export function sortByOccurrence(events: readonly LedgerEvent[]): LedgerEvent[] {
  return [...events].sort((a, b) =>
    a.occurred_at === b.occurred_at ? 0 : a.occurred_at < b.occurred_at ? -1 : 1,
  );
}
