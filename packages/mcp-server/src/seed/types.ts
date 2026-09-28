import type {
  Evidence,
  Instant,
  Interval,
  Justification,
  Money,
  OwedPromise,
  RemedyForm,
} from "@owed/domain";

export type ExchangeSpec =
  | { type: "OFFER"; at: Instant; amount: Money; form: RemedyForm; terms?: string }
  | { type: "COUNTER"; at: Instant; amount: Money; justification: Justification };

export type OutcomeSpec =
  | { kind: "settled"; at: Instant; amount: Money; form: RemedyForm; recovered_at?: Instant }
  | { kind: "escalated"; at: Instant; reason: string; route: string }
  | { kind: "open" };

export interface ClaimSpec {
  id: string;
  ask: Money;
  proposed_at: Instant;
  filed_at: Instant;
  confirmed_by: string;
  attached_evidence_ids?: string[];
  exchanges: ExchangeSpec[];
  outcome: OutcomeSpec;
}

/**
 * One promise's whole life.
 *
 * The verdict is deliberately absent: the breach engine computes it from the evidence
 * and uptime below. Seeded data states what was *observed*, never what to conclude —
 * so the demo exercises the same engine the evaluation measures.
 */
export interface ArcSpec {
  promise: OwedPromise;
  evidence?: Evidence[];
  /** Stretches the doorbell was watching. */
  uptime?: Interval[];
  /** When the engine runs. */
  assessed_at: Instant;
  claim?: ClaimSpec;
}
