import {
  around,
  compareInstants,
  containsInstant,
  type Detection,
  type Evidence,
  formatMoney,
  type Instant,
  type Interval,
  interval,
  isCarrierScan,
  isDoorbellEvent,
  isPriceObserved,
  isRefundObserved,
  MINUTE_MS,
  toEpochMs,
  withinWindow,
} from "@owed/domain";
import { coverageGaps, measureCoverage } from "../evidence/coverage.js";
import {
  conclude,
  confidenceFromCoverage,
  type Detector,
  type DetectorInput,
  hasPassed,
} from "./types.js";

/** How far either side of a claimed moment counts as "around" it. */
export const TOLERANCE_MS = 30 * MINUTE_MS;

const byTime = (a: Evidence, b: Evidence) => compareInstants(a.captured_at, b.captured_at);

function sorted(evidence: readonly Evidence[]): Evidence[] {
  return [...evidence].sort(byTime);
}

function ids(evidence: readonly Evidence[]): string[] {
  return evidence.map((e) => e.id);
}

/** Evidence that somebody actually came to the door. */
function arrivalSightings(evidence: readonly Evidence[]): Evidence[] {
  return sorted(evidence).filter(
    (e) => isDoorbellEvent(e) && (e.event === "package_placed" || e.event === "person_detected"),
  );
}

function firstDelivery(evidence: readonly Evidence[]): Evidence | undefined {
  return sorted(evidence).find((e) => isCarrierScan(e) && e.status === "delivered");
}

function watchedAt(uptime: readonly Interval[], instant: Instant): boolean {
  return uptime.some((window) => containsInstant(window, instant));
}

function describeGaps(uptime: readonly Interval[], evaluation: Interval): string {
  const gaps = coverageGaps(uptime, evaluation);
  if (gaps.length === 0) return "with no gaps in what was watched";
  const minutes = gaps.reduce(
    (total, gap) => total + (toEpochMs(gap.end) - toEpochMs(gap.start)),
    0,
  );
  return `with ${Math.round(minutes / MINUTE_MS)} minutes unwatched`;
}

// ---------------------------------------------------------------------------

/**
 * A ride or courier that promised to arrive by a given moment.
 *
 * Coverage is 1: lateness is read off the clock, and a clock has no gaps.
 */
export const lateEta: Detector = {
  kind: "late_eta",
  appliesTo: (promise) => promise.kind === "eta" && promise.deadline !== undefined,
  detect({ promise, evidence, now }: DetectorInput): Detection | undefined {
    const deadline = promise.deadline;
    if (deadline === undefined) return undefined;

    const arrival = sorted(evidence).find(
      (e) => e.kind === "timestamp" || (isCarrierScan(e) && e.status === "delivered"),
    );
    const decidable = hasPassed(now, deadline);
    const end = arrival?.captured_at ?? (decidable ? now : deadline);

    if (arrival === undefined) {
      const evaluation = interval(promise.made_at, end);
      return conclude({
        promise,
        kind: "late_eta",
        evaluation,
        observed: [evaluation],
        confidence: 0.9,
        evidence_ids: [],
        explanation: decidable
          ? "The promised arrival time passed with nothing recorded as having arrived."
          : "Still waiting for the promised arrival.",
        outcome: decidable ? "broken" : "unknown",
        decidable,
      });
    }

    const lateByMs = toEpochMs(arrival.captured_at) - toEpochMs(deadline);
    const late = lateByMs > 0;
    const evaluation = interval(promise.made_at, arrival.captured_at);
    return conclude({
      promise,
      kind: "late_eta",
      evaluation,
      observed: [evaluation],
      confidence: 0.99,
      evidence_ids: [arrival.id],
      explanation: late
        ? `Arrived ${Math.round(lateByMs / MINUTE_MS)} minutes after the promised time.`
        : "Arrived inside the promised time.",
      outcome: late ? "broken" : "kept",
      decidable: true,
    });
  },
};

/**
 * A delivery or appointment window that closed before anything turned up.
 *
 * When a carrier scan settles it, coverage is 1 — a carrier's own log has no gaps.
 * When only the doorbell can settle it, coverage is what the camera actually saw.
 */
export const missedWindow: Detector = {
  kind: "missed_window",
  appliesTo: (promise) =>
    (promise.kind === "delivery_window" || promise.kind === "appointment_slot") &&
    promise.window !== undefined,
  detect({ promise, evidence, uptime, now }: DetectorInput): Detection | undefined {
    const window = promise.window;
    if (window === undefined) return undefined;

    const decidable = hasPassed(now, window.end);
    const scan = firstDelivery(evidence);
    const sighting = arrivalSightings(evidence)[0];
    const fulfilment = scan ?? sighting;

    // A carrier log settles the question outright; a camera only sees what it saw.
    // Stated as intervals rather than a number, so the card can draw exactly the gaps
    // this verdict was reached in spite of — and no others.
    const observed = scan !== undefined ? [window] : uptime;
    const coverage = measureCoverage(observed, window);

    if (fulfilment !== undefined) {
      const inside = withinWindow(window, fulfilment.captured_at);
      const lateByMs = toEpochMs(fulfilment.captured_at) - toEpochMs(window.end);
      return conclude({
        promise,
        kind: "missed_window",
        evaluation: window,
        observed,
        confidence: 0.98,
        evidence_ids: [fulfilment.id],
        explanation: inside
          ? "Arrived inside the promised window."
          : `Arrived ${Math.round(lateByMs / MINUTE_MS)} minutes after the window closed.`,
        outcome: inside ? "kept" : "broken",
        decidable: true,
      });
    }

    return conclude({
      promise,
      kind: "missed_window",
      evaluation: window,
      observed,
      confidence: confidenceFromCoverage(coverage),
      evidence_ids: [],
      explanation: decidable
        ? `The window closed with nothing recorded as having arrived, ${describeGaps(observed, window)}.`
        : "The window is still open.",
      outcome: decidable ? "broken" : "unknown",
      decidable,
    });
  },
};

/**
 * Scanned as delivered, but the door says otherwise.
 *
 * The interval that matters is the scan plus or minus a tolerance, not the whole
 * delivery window: what is in question is a single claimed moment.
 */
export const phantomDelivery: Detector = {
  kind: "phantom_delivery",
  appliesTo: (promise) => promise.kind === "delivery_window",
  detect({ promise, evidence, uptime, now }: DetectorInput): Detection | undefined {
    const scan = firstDelivery(evidence);
    if (scan === undefined) return undefined;

    const evaluation = around(scan.captured_at, TOLERANCE_MS);
    const coverage = measureCoverage(uptime, evaluation);
    const sightings = arrivalSightings(evidence).filter((e) =>
      containsInstant(evaluation, e.captured_at),
    );

    if (sightings.length > 0) {
      return conclude({
        promise,
        kind: "phantom_delivery",
        evaluation,
        observed: uptime,
        confidence: 0.97,
        evidence_ids: ids([scan, ...sightings]),
        explanation: "The scan matches what the door recorded.",
        outcome: "kept",
        decidable: true,
      });
    }

    // If the claimed moment itself fell in a gap, the absence of a sighting says much
    // less, however good the surrounding coverage looks.
    const sawTheMoment = watchedAt(uptime, scan.captured_at);
    const confidence = confidenceFromCoverage(coverage) * (sawTheMoment ? 1 : 0.6);
    const snapshots = evidence.filter(
      (e) => e.kind === "doorbell_snapshot" && containsInstant(evaluation, e.captured_at),
    );

    return conclude({
      promise,
      kind: "phantom_delivery",
      evaluation,
      observed: uptime,
      confidence,
      evidence_ids: ids([scan, ...snapshots]),
      explanation: `The carrier scanned this delivered, but the door was watched for ${Math.round(
        coverage * 100,
      )}% of the hour around that scan and recorded nobody arriving, ${describeGaps(uptime, evaluation)}.`,
      outcome: "broken",
      decidable: hasPassed(now, evaluation.end),
    });
  },
};

/** Nobody came to an appointment that was booked. */
export const noShow: Detector = {
  kind: "no_show",
  appliesTo: (promise) => promise.kind === "appointment_slot" && promise.window !== undefined,
  detect({ promise, evidence, uptime, now }: DetectorInput): Detection | undefined {
    const slot = promise.window;
    if (slot === undefined) return undefined;

    const evaluation = interval(
      around(slot.start, TOLERANCE_MS).start,
      around(slot.end, TOLERANCE_MS).end,
    );
    const coverage = measureCoverage(uptime, evaluation);
    const sightings = arrivalSightings(evidence).filter((e) =>
      containsInstant(evaluation, e.captured_at),
    );

    if (sightings.length > 0) {
      const first = sightings[0] as Evidence;
      return conclude({
        promise,
        kind: "no_show",
        evaluation,
        observed: uptime,
        confidence: 0.97,
        evidence_ids: ids(sightings),
        explanation: "Somebody arrived for the appointment.",
        outcome: withinWindow(slot, first.captured_at) ? "kept" : "broken",
        decidable: true,
      });
    }

    return conclude({
      promise,
      kind: "no_show",
      evaluation,
      observed: uptime,
      confidence: confidenceFromCoverage(coverage),
      evidence_ids: [],
      explanation: `Nobody arrived during the appointment slot, ${describeGaps(uptime, evaluation)}.`,
      outcome: "broken",
      decidable: hasPassed(now, evaluation.end),
    });
  },
};

/**
 * A refund promised by a date that has not arrived.
 *
 * Coverage is 1: whether money reached the household is something the household
 * knows directly, not something it has to have been watching for.
 */
export const lateRefund: Detector = {
  kind: "late_refund",
  appliesTo: (promise) => promise.kind === "refund_sla" && promise.deadline !== undefined,
  detect({ promise, evidence, now }: DetectorInput): Detection | undefined {
    const deadline = promise.deadline;
    if (deadline === undefined) return undefined;

    const refund = sorted(evidence).find(isRefundObserved);
    const decidable = hasPassed(now, deadline);

    if (refund !== undefined) {
      const late = compareInstants(refund.captured_at, deadline) > 0;
      const daysLate = Math.round(
        (toEpochMs(refund.captured_at) - toEpochMs(deadline)) / (24 * 60 * MINUTE_MS),
      );

      /**
       * Half the money is not the money.
       *
       * Asking only whether *something* arrived reads a partial refund as a refund
       * kept, which is the one answer a household would call a lie. Compared only when
       * the promise named a figure and the currencies agree; where either is missing,
       * arriving on time is all this detector can honestly claim to know.
       */
      const owed = promise.amount_at_stake;
      const short =
        owed !== undefined &&
        refund.amount.currency === owed.currency &&
        refund.amount.minor < owed.minor;

      const refunded = interval(promise.made_at, refund.captured_at);
      return conclude({
        promise,
        kind: "late_refund",
        evaluation: refunded,
        observed: [refunded],
        confidence: 1,
        evidence_ids: [refund.id],
        explanation: short
          ? `Only ${formatMoney(refund.amount)} of the ${formatMoney(owed)} came back.`
          : late
            ? `The refund arrived ${daysLate} days after it was promised.`
            : "The refund arrived when it was promised.",
        outcome: late || short ? "broken" : "kept",
        decidable: true,
      });
    }

    const daysWaiting = Math.round(
      (toEpochMs(now) - toEpochMs(promise.made_at)) / (24 * 60 * MINUTE_MS),
    );
    const waited = interval(promise.made_at, decidable ? now : deadline);
    return conclude({
      promise,
      kind: "late_refund",
      evaluation: waited,
      observed: [waited],
      confidence: 1,
      evidence_ids: [],
      explanation: decidable
        ? `The refund was promised sooner than this and has not arrived. This is day ${daysWaiting}.`
        : "The refund is not due yet.",
      outcome: decidable ? "broken" : "unknown",
      decidable,
    });
  },
};

/**
 * A price that fell inside a price-match window.
 *
 * A price seen is a fact, not a sighting that could have been missed, so coverage is 1.
 */
export const priceDrop: Detector = {
  kind: "price_drop",
  appliesTo: (promise) => promise.kind === "price_match" && promise.window !== undefined,
  detect({ promise, evidence, now }: DetectorInput): Detection | undefined {
    const window = promise.window;
    const paid = promise.amount_at_stake;
    if (window === undefined || paid === undefined) return undefined;

    const observations = sorted(evidence)
      .filter(isPriceObserved)
      .filter((e) => withinWindow(window, e.captured_at));

    const cheapest = observations.reduce<(typeof observations)[number] | undefined>(
      (lowest, current) =>
        lowest === undefined || current.amount.minor < lowest.amount.minor ? current : lowest,
      undefined,
    );

    const dropped = cheapest !== undefined && cheapest.amount.minor < paid.minor;
    const closed = hasPassed(now, window.end);

    const watchedWindow = interval(window.start, closed ? window.end : now);
    return conclude({
      promise,
      kind: "price_drop",
      evaluation: watchedWindow,
      observed: [watchedWindow],
      confidence: 0.98,
      evidence_ids: dropped && cheapest ? [cheapest.id] : [],
      explanation:
        dropped && cheapest
          ? `The price fell from ${formatMoney(paid)} to ${formatMoney(cheapest.amount)} inside the price promise.`
          : "The price did not fall inside the price promise.",
      outcome: dropped ? "broken" : closed ? "kept" : "unknown",
      decidable: dropped || closed,
    });
  },
};

/** Ordered most specific first: a phantom delivery outranks a missed window. */
export const DETECTORS: readonly Detector[] = [
  phantomDelivery,
  noShow,
  missedWindow,
  lateEta,
  lateRefund,
  priceDrop,
];
