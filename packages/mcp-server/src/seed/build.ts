import { assessPromise } from "@owed/core";
import type { Evidence, Instant, LedgerEvent, ObservationWindow } from "@owed/domain";
import type { ArcSpec } from "./types.js";

export const DOORBELL_SOURCE = "src_doorbell";

let sequence = 0;

function nextId(prefix: string): string {
  sequence += 1;
  return `${prefix}_${String(sequence).padStart(4, "0")}`;
}

export function resetIds(): void {
  sequence = 0;
}

/**
 * Scenario time and wall time are the same in seeded data: the whole point is that a
 * replay produces byte-identical state on every run (plan §6.3).
 */
function envelope(household_id: string, occurred_at: Instant) {
  return { id: nextId("evt"), household_id, occurred_at, recorded_at: occurred_at };
}

export function evidenceEvent(household_id: string, evidence: Evidence): LedgerEvent {
  return { ...envelope(household_id, evidence.captured_at), type: "EvidenceObserved", evidence };
}

export function uptimeEvent(household_id: string, window: ObservationWindow): LedgerEvent {
  return { ...envelope(household_id, window.interval.start), type: "SourceUptimeRecorded", window };
}

function observationWindows(household_id: string, arc: ArcSpec): ObservationWindow[] {
  return (arc.uptime ?? []).map((interval) => ({
    source_id: DOORBELL_SOURCE,
    household_id,
    interval,
  }));
}

/** Expand one arc into its ledger events, in the order they occurred. */
export function arcEvents(household_id: string, arc: ArcSpec): LedgerEvent[] {
  const uptime = observationWindows(household_id, arc);
  const evidence = arc.evidence ?? [];

  const events: LedgerEvent[] = [
    {
      ...envelope(household_id, arc.promise.made_at),
      type: "PromiseCaptured",
      promise: arc.promise,
    },
    ...uptime.map((window) => uptimeEvent(household_id, window)),
    ...evidence.map((item) => evidenceEvent(household_id, item)),
  ];

  // The verdict is computed, not asserted. If no detector can speak to a promise, that
  // is a hole in the engine and the seed refuses to paper over it.
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
    ...envelope(household_id, arc.assessed_at),
    type: "PromiseAssessed",
    assessment: { ...detection, id: nextId("brc"), detected_at: arc.assessed_at },
  });

  const claim = arc.claim;
  if (!claim) return events;

  events.push({
    ...envelope(household_id, claim.proposed_at),
    type: "ClaimProposed",
    claim_id: claim.id,
    promise_id: arc.promise.id,
    merchant: arc.promise.merchant,
    ask: claim.ask,
    route: "agent",
  });

  events.push({
    ...envelope(household_id, claim.filed_at),
    type: "ClaimFiled",
    claim_id: claim.id,
    promise_id: arc.promise.id,
    confirmed_by: claim.confirmed_by,
    attached_evidence_ids: claim.attached_evidence_ids ?? [],
  });

  for (const exchange of claim.exchanges) {
    events.push(
      exchange.type === "OFFER"
        ? {
            ...envelope(household_id, exchange.at),
            type: "OfferReceived",
            claim_id: claim.id,
            amount: exchange.amount,
            form: exchange.form,
            ...(exchange.terms === undefined ? {} : { terms: exchange.terms }),
          }
        : {
            ...envelope(household_id, exchange.at),
            type: "CounterSent",
            claim_id: claim.id,
            amount: exchange.amount,
            justification: exchange.justification,
          },
    );
  }

  const outcome = claim.outcome;
  if (outcome.kind === "settled") {
    const rounds = claim.exchanges.filter((e) => e.type === "OFFER").length + 1;
    events.push({
      ...envelope(household_id, outcome.at),
      type: "Settled",
      claim_id: claim.id,
      amount: outcome.amount,
      form: outcome.form,
      rounds,
    });

    if (outcome.recovered_at !== undefined) {
      const creditId = nextId("evd");
      events.push({
        ...envelope(household_id, outcome.recovered_at),
        type: "EvidenceObserved",
        evidence: {
          id: creditId,
          household_id,
          source_id: "src_inbox",
          kind: "refund_observed",
          captured_at: outcome.recovered_at,
          promise_id: arc.promise.id,
          amount: outcome.amount,
        },
      });
      events.push({
        ...envelope(household_id, outcome.recovered_at),
        type: "Recovered",
        claim_id: claim.id,
        amount: outcome.amount,
        evidence_id: creditId,
      });
    }
  } else if (outcome.kind === "escalated") {
    events.push({
      ...envelope(household_id, outcome.at),
      type: "Escalated",
      claim_id: claim.id,
      reason: outcome.reason,
      escalation_route: outcome.route,
    });
  }

  return events;
}

/** Ledger events must be replayed in `occurred_at` order regardless of authoring order. */
export function sortByOccurrence(events: readonly LedgerEvent[]): LedgerEvent[] {
  return [...events].sort((a, b) =>
    a.occurred_at === b.occurred_at ? 0 : a.occurred_at < b.occurred_at ? -1 : 1,
  );
}
