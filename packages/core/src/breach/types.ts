import type {
  BreachKind,
  Confidence,
  Coverage,
  Detection,
  Evidence,
  Instant,
  Interval,
  OwedPromise,
  Verdict,
} from "@owed/domain";
import { meetsBreachGate, toEpochMs } from "@owed/domain";
import { measureCoverage, observedWithin } from "../evidence/coverage.js";

export interface DetectorInput {
  promise: OwedPromise;
  evidence: readonly Evidence[];
  /** Stretches some source was actually watching. */
  uptime: readonly Interval[];
  now: Instant;
}

export interface Detector {
  kind: BreachKind;
  /** Whether this detector has anything to say about this promise. */
  appliesTo(promise: OwedPromise): boolean;
  detect(input: DetectorInput): Detection | undefined;
}

export interface ConcludeInput {
  promise: OwedPromise;
  kind: BreachKind;
  evaluation: Interval;
  /**
   * What this detector could actually see over `evaluation`.
   *
   * Stated rather than a coverage number, because a number cannot be checked against
   * the gaps a card draws and an interval can. A detector that reads a clock observes
   * the whole interval; one that reads a camera observes whatever the camera was up
   * for. Coverage is derived from this and never passed in.
   */
  observed: readonly Interval[];
  confidence: Confidence;
  evidence_ids: string[];
  explanation: string;
  /** What the evidence says happened. */
  outcome: "kept" | "broken" | "unknown";
  /** Whether the moment of judgement has passed. */
  decidable: boolean;
}

/**
 * Turn a detector's reading into a verdict, applying the two gates in one place.
 *
 * Every detector routes through this so the promise "Owed never files below the
 * thresholds" is enforced structurally rather than remembered six times.
 */
export function conclude(input: ConcludeInput): Detection {
  // Normalised here so every detection carries the same shape: clipped to the interval
  // it is about, merged and sorted, with coverage read off it.
  const observed = observedWithin(input.observed, input.evaluation);
  const coverage = measureCoverage(observed, input.evaluation);
  const verdict = verdictFor({ ...input, coverage });

  return {
    promise_id: input.promise.id,
    kind: input.kind,
    verdict,
    confidence: input.confidence,
    coverage,
    evaluation_interval: input.evaluation,
    observed,
    evidence_ids: input.evidence_ids,
    explanation: input.explanation,
  };
}

function verdictFor(input: ConcludeInput & { coverage: Coverage }): Verdict {
  if (input.outcome === "kept") return "Kept";
  if (!input.decidable) return "Undetermined";
  if (input.outcome === "broken" && meetsBreachGate(input.confidence, input.coverage)) {
    return "Breached";
  }
  // Past the deadline but under the gate: say what was and was not seen, never claim.
  return "Suspected";
}

export function hasPassed(now: Instant, moment: Instant): boolean {
  return toEpochMs(now) >= toEpochMs(moment);
}

/**
 * How much a gap could have hidden.
 *
 * Read as: a real event would have to fall inside the unobserved fraction to explain
 * the absence of any sighting, and roughly half of a gap is a plausible hiding place.
 * That yields 0.91 at 82% coverage and 0.60 at 20% — high enough to act on when the
 * camera was mostly up, and visibly not enough when it was not.
 */
export const GAP_CREDIBILITY = 0.5;

export function confidenceFromCoverage(coverage: Coverage): Confidence {
  return 1 - (1 - coverage) * GAP_CREDIBILITY;
}
