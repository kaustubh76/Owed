import type { Instant, LedgerEvent, OwedPromise, PromiseKind } from "@owed/domain";
import type { IdGen } from "../time/determinism.js";

/**
 * How confident a read has to be before Owed starts tracking the promise.
 *
 * `PromiseStatus` has had `Candidate` and `Captured` since it was declared, and
 * `ui-views/src/ledger/labels.ts` has had a label and a sort rank for each —
 * "not yet tracked" and "captured" — while nothing produced either. The seeded week
 * writes its promises straight in as `Watching`, and the extractor was only ever used to
 * recover an `evidence_text` for one, so the step that turns a read into a ledger entry
 * did not exist and the two statuses had no producer.
 *
 * This is that step, and the threshold is what the two statuses are *for*. The rules
 * extractor emits three confidences — 0.95 where the cue sits next to the time it
 * qualifies, 0.82 where it is further away, 0.8 where the promise is inferred from a
 * guarantee rather than stated. Over the 120-message pre-registered corpus that is 89
 * reads at 0.95 and 11 below it, so 0.85 splits real input rather than sitting somewhere
 * nothing reaches.
 *
 * A `Candidate` is recorded and not acted on: the household can see Owed found something
 * and see the sentence it came from, and Owed will not file a claim on a promise it is not
 * sure anybody made.
 */
export const TRACKING_CONFIDENCE = 0.85;

/** Recorded-and-watched, or recorded-and-not-tracked. Nothing else is decided here. */
export function statusForConfidence(confidence: number): "Candidate" | "Captured" {
  return confidence >= TRACKING_CONFIDENCE ? "Captured" : "Candidate";
}

/**
 * One promise read out of a message.
 *
 * Structural rather than `@owed/extractor`'s `Extraction`, so core keeps its three
 * dependencies and either extractor — the rules one or the Bedrock one — satisfies it
 * without core knowing which ran.
 */
export interface ReadPromise {
  kind: PromiseKind;
  confidence: number;
  window?: { start: Instant; end: Instant } | undefined;
  deadline?: Instant | undefined;
  amount_at_stake?: { minor: number; currency: string } | undefined;
  evidence_text: string;
}

export interface CapturePromisesInput {
  householdId: string;
  /** The message these were read from; becomes each promise's `source_ref`. */
  messageId: string;
  merchant: string;
  /** When the message arrived, which is when the promise was made. */
  receivedAt: Instant;
  currency: string;
  reads: readonly ReadPromise[];
  idGen: IdGen;
}

export interface CapturePromisesResult {
  events: LedgerEvent[];
  promises: OwedPromise[];
}

/**
 * Turn what an extractor read out of a message into ledger events.
 *
 * Every promise carries the sentence it came from. The extractor guarantees an
 * `evidence_text` for each read — "a promise a household cannot trace back to a sentence
 * somebody actually wrote them is a promise Owed invented" — and that guarantee is worth
 * nothing if this step drops it, so it travels into the ledger as `source_quote`.
 *
 * Ids are deterministic in the order the reads arrive, so replaying the same message
 * produces the same ledger. Nothing here decides whether a promise was kept: that is the
 * breach engine's job, and it reasons about evidence rather than about this status.
 */
export function capturePromises(input: CapturePromisesInput): CapturePromisesResult {
  const promises: OwedPromise[] = [];
  const events: LedgerEvent[] = [];

  for (const read of input.reads) {
    const promise: OwedPromise = {
      id: input.idGen.next("prm"),
      household_id: input.householdId,
      merchant: input.merchant,
      source_ref: input.messageId,
      source_quote: read.evidence_text,
      kind: read.kind,
      made_at: input.receivedAt,
      currency: input.currency,
      confidence: read.confidence,
      status: statusForConfidence(read.confidence),
      ...(read.window === undefined ? {} : { window: read.window }),
      ...(read.deadline === undefined ? {} : { deadline: read.deadline }),
      ...(read.amount_at_stake === undefined ? {} : { amount_at_stake: read.amount_at_stake }),
    };

    promises.push(promise);
    events.push({
      id: input.idGen.next("evt"),
      household_id: input.householdId,
      occurred_at: input.receivedAt,
      recorded_at: input.receivedAt,
      type: "PromiseCaptured",
      promise,
    });
  }

  return { events, promises };
}
