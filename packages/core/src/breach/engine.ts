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
      /**
       * Only evidence attached to this promise.
       *
       * This used to admit `e.promise_id === undefined` as well, which turned an optional
       * field into a household-wide broadcast: every untagged item reached every promise's
       * detectors. That was survivable while the detectors only looked at evidence within
       * half an hour of a carrier scan. It stopped being survivable when `phantomDelivery`
       * and `noShow` were corrected to answer "did anything arrive?" instead of "did
       * anything arrive near the scan?", because an untagged sighting then only has to
       * *exist* to exculpate a promise it was never about.
       *
       * The failure that permits is the silent one: a promise that **was** broken reading
       * as kept because of an event elsewhere in the household, so the money is never
       * mentioned. A false positive argues with a merchant; this one just never tells the
       * household.
       *
       * Nothing produces untagged evidence — both seed constructors and the corpus take
       * `promise_id` as a required argument, the only runtime producer hard-codes it
       * (`filing.ts`), and `projections.ts` drops untagged evidence on the way into the
       * ledger anyway. So this clause had no live purpose and one latent hazard.
       *
       * Uptime stays household-wide below, deliberately: what a camera could see is not a
       * property of any one promise, and saying "it was up and saw nothing" is the whole
       * phantom-delivery signal.
       */
      evidence: evidence.filter((e) => e.promise_id === promise.id),
      uptime: uptime
        .filter((window) => window.household_id === promise.household_id)
        .map((window) => window.interval),
      now,
    },
    detectors,
  );
}
