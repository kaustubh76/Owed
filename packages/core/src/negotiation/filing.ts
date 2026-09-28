import {
  addMs,
  type ClaimRoute,
  type Detection,
  type Evidence,
  type Instant,
  type LedgerEvent,
  type OwedPromise,
} from "@owed/domain";
import { type Respondent, runSession, type SessionResult } from "@owed/recourse-protocol";
import type { IdGen } from "../time/determinism.js";
import { buildClaim } from "./claim.js";
import { createNegotiator, type RemedyBounds } from "./negotiator.js";

/** A minute between messages unless the caller knows better. */
export const DEFAULT_REPLY_INTERVAL_MS = 60_000;

export interface FileClaimInput {
  householdId: string;
  claimId: string;
  promise: OwedPromise;
  detection: Detection;
  evidence: readonly Evidence[];
  bounds: RemedyBounds;
  respondent: Respondent;
  /** When Owed proposed the claim — before the household said yes. */
  proposedAt: Instant;
  /** When the household confirmed. Nothing is filed without this. */
  filedAt: Instant;
  confirmedBy: string;
  attachedEvidenceIds?: readonly string[];
  /** Negotiations take time; spacing messages is what lets a replay catch one mid-flight. */
  replyIntervalMs?: number;
  maxRounds?: number;
  route?: ClaimRoute;
  /** When the credit was actually observed. Absent means it has not arrived. */
  recoveredAt?: Instant;
  coverageStatement?: string;
  idGen: IdGen;
}

export interface FileClaimResult {
  events: LedgerEvent[];
  session: SessionResult;
}

/**
 * File a claim and negotiate it, producing the ledger events that record what happened.
 *
 * One implementation with two callers: the seeded week runs it against in-process agents,
 * and the `claim_file` tool runs it against merchant agents over HTTP. Same protocol,
 * same strategy, same events — so the demo exercises exactly what the evaluation measures.
 */
export async function fileClaim(input: FileClaimInput): Promise<FileClaimResult> {
  const {
    householdId,
    claimId,
    promise,
    detection,
    evidence,
    bounds,
    respondent,
    proposedAt,
    filedAt,
    confirmedBy,
    idGen,
  } = input;

  const interval = input.replyIntervalMs ?? DEFAULT_REPLY_INTERVAL_MS;
  const at = (step: number): Instant => addMs(filedAt, step * interval);
  const envelope = (occurred_at: Instant) => ({
    id: idGen.next("evt"),
    household_id: householdId,
    occurred_at,
    recorded_at: occurred_at,
  });

  const claim = buildClaim({ claimId, at: filedAt, promise, detection, evidence, bounds });

  const negotiator = {
    ...createNegotiator({
      bounds,
      ...(input.maxRounds === undefined ? {} : { maxRounds: input.maxRounds }),
      evidenceIds: detection.evidence_ids,
      ...(input.coverageStatement === undefined
        ? {}
        : { coverageStatement: input.coverageStatement }),
    }),
    open: () => claim,
  };

  const session = await runSession(negotiator, respondent, {
    clock: at,
    ...(input.maxRounds === undefined ? {} : { maxRounds: input.maxRounds }),
  });

  const events: LedgerEvent[] = [
    {
      ...envelope(proposedAt),
      type: "ClaimProposed",
      claim_id: claimId,
      promise_id: promise.id,
      merchant: promise.merchant,
      ask: claim.ask,
      // What the merchant published, which is what the household is actually owed.
      // The ask is a negotiating position and would overstate it.
      expected: bounds.reservation,
      route: input.route ?? "agent",
    },
    {
      ...envelope(filedAt),
      type: "ClaimFiled",
      claim_id: claimId,
      promise_id: promise.id,
      confirmed_by: confirmedBy,
      attached_evidence_ids: [...(input.attachedEvidenceIds ?? [])],
    },
  ];

  // Events are stamped by position in the exchange, not by whatever clock the merchant
  // wrote on its message. A remote agent's clock is not ours to trust, and spacing the
  // messages is what lets a replay catch a negotiation still in flight.
  session.transcript.forEach((message, index) => {
    const occurredAt = at(index);
    if (message.type === "OFFER") {
      events.push({
        ...envelope(occurredAt),
        type: "OfferReceived",
        claim_id: claimId,
        amount: message.amount,
        form: message.form,
        ...(message.terms === undefined ? {} : { terms: message.terms }),
      });
    } else if (message.type === "COUNTER") {
      events.push({
        ...envelope(occurredAt),
        type: "CounterSent",
        claim_id: claimId,
        amount: message.amount,
        justification: message.justification,
      });
    } else if (message.type === "SETTLE") {
      events.push({
        ...envelope(occurredAt),
        type: "Settled",
        claim_id: claimId,
        amount: message.amount,
        form: message.form,
        rounds: session.rounds,
        ...(message.reference === undefined ? {} : { reference: message.reference }),
      });
    } else if (message.type === "DECLINE") {
      events.push({
        ...envelope(occurredAt),
        type: "Escalated",
        claim_id: claimId,
        reason: message.reason,
        escalation_route: message.escalation_route,
      });
    }
  });

  if (session.outcome === "escalated" && session.settled === undefined) {
    const alreadyRecorded = events.some((event) => event.type === "Escalated");
    if (!alreadyRecorded) {
      events.push({
        ...envelope(at(session.transcript.length)),
        type: "Escalated",
        claim_id: claimId,
        reason: session.reason,
        escalation_route: `${promise.merchant} customer relations`,
      });
    }
  }

  const settled = session.settled;
  if (settled !== undefined && input.recoveredAt !== undefined) {
    const creditId = idGen.next("evd");
    events.push({
      ...envelope(input.recoveredAt),
      type: "EvidenceObserved",
      evidence: {
        id: creditId,
        household_id: householdId,
        source_id: "src_inbox",
        kind: "refund_observed",
        captured_at: input.recoveredAt,
        promise_id: promise.id,
        amount: settled,
      },
    });
    events.push({
      ...envelope(input.recoveredAt),
      type: "Recovered",
      claim_id: claimId,
      amount: settled,
      evidence_id: creditId,
    });
  }

  return { events, session };
}
