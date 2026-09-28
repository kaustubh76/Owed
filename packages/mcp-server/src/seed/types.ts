import type { Evidence, Instant, Interval, OwedPromise } from "@owed/domain";

/**
 * A claim, stated as the facts of filing it.
 *
 * There are no offers or counters here. The negotiation actually runs, against a merchant
 * agent, over the merchant's own published policy — so the transcript is an outcome
 * rather than a script.
 */
export interface ClaimSpec {
  id: string;
  /** When Owed proposed it — before the household said yes. */
  proposed_at: Instant;
  /** When the household confirmed. Nothing is filed without this. */
  filed_at: Instant;
  confirmed_by: string;
  attached_evidence_ids?: string[];
  /**
   * How long each reply takes. Spacing messages is what lets a replay catch a
   * negotiation still in flight, which is the honest state for a claim filed hours ago.
   */
  reply_interval_ms?: number;
  /** When the credit was observed. Absent means it has not arrived. */
  recovered_at?: Instant;
  coverage_statement?: string;
}

/**
 * One promise's whole life.
 *
 * The verdict is absent because the breach engine computes it, and the figures are absent
 * because the policy library supplies them. Seeded data states what was *observed*, never
 * what to conclude.
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
