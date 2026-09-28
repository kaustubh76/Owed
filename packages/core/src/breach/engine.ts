import type {
  Detection,
  Evidence,
  Instant,
  ObservationWindow,
  OwedPromise,
  Verdict,
} from "@owed/domain";
import { DETECTORS } from "./detectors.js";
import type { Detector, DetectorInput } from "./types.js";

/**
 * How loudly a verdict speaks.
 *
 * Several detectors can apply to one promise and each answers a different question:
 * a parcel can be scanned inside its window (so it did not miss the window) while
 * nobody came to the door (so it may never have arrived). The most severe reading
 * wins, and ties fall to the more specific detector.
 */
const SEVERITY: Readonly<Record<Verdict, number>> = {
  Breached: 3,
  Suspected: 2,
  Kept: 1,
  Undetermined: 0,
};

export function assess(
  input: DetectorInput,
  detectors: readonly Detector[] = DETECTORS,
): Detection | undefined {
  let best: Detection | undefined;

  for (const detector of detectors) {
    if (!detector.appliesTo(input.promise)) continue;
    const detection = detector.detect(input);
    if (detection === undefined) continue;
    // Strictly greater keeps the first, most specific detector on a tie.
    if (best === undefined || SEVERITY[detection.verdict] > SEVERITY[best.verdict]) {
      best = detection;
    }
  }

  return best;
}

export interface AssessPromiseInput {
  promise: OwedPromise;
  evidence: readonly Evidence[];
  uptime: readonly ObservationWindow[];
  now: Instant;
  detectors?: readonly Detector[];
}

/** Assess one promise against everything observed for it. */
export function assessPromise({
  promise,
  evidence,
  uptime,
  now,
  detectors,
}: AssessPromiseInput): Detection | undefined {
  return assess(
    {
      promise,
      evidence: evidence.filter((e) => e.promise_id === undefined || e.promise_id === promise.id),
      uptime: uptime
        .filter((window) => window.household_id === promise.household_id)
        .map((window) => window.interval),
      now,
    },
    detectors,
  );
}
