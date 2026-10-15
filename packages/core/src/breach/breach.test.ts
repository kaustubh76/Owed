import type {
  Evidence,
  Instant,
  Interval,
  ObservationWindow,
  OwedPromise,
  PromiseKind,
} from "@owed/domain";
import {
  BREACH_CONFIDENCE_MIN,
  BREACH_COVERAGE_MIN,
  coveragePercent,
  durationMs,
  fromEpochMs,
  interval,
  toEpochMs,
  usd,
} from "@owed/domain";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { coverageGaps, measuredMs } from "../evidence/coverage.js";
import { missedWindow } from "./detectors.js";
import { assessPromise } from "./engine.js";
import { conclude } from "./types.js";

const HH = "hh_test";
const at = (hhmm: string): Instant => `2026-10-06T${hhmm}:00-07:00`;

/**
 * A stretch of the 13:00-14:00 hour covering exactly `fraction` of it.
 *
 * The properties below used to hand `conclude` a coverage number directly. Coverage is
 * now read off what a detector says it saw, so they hand it the watching instead — one
 * fewer thing a detector can assert without it being true.
 */
const watched = (fraction: number): Interval[] =>
  fraction <= 0
    ? []
    : [interval(at("13:00"), fromEpochMs(toEpochMs(at("13:00")) + fraction * 60 * 60 * 1000))];

function promise(kind: PromiseKind, extra: Partial<OwedPromise> = {}): OwedPromise {
  return {
    id: "prm_1",
    household_id: HH,
    merchant: "Northwind Parcel",
    source_ref: "msg_1",
    kind,
    made_at: at("08:00"),
    currency: "USD",
    confidence: 0.98,
    status: "Watching",
    ...extra,
  };
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type EvidenceDraft = DistributiveOmit<Evidence, "id" | "household_id" | "source_id">;

let evidenceSeq = 0;
function evidence(partial: EvidenceDraft): Evidence {
  evidenceSeq += 1;
  return {
    id: `evd_${evidenceSeq}`,
    household_id: HH,
    source_id: "src_test",
    ...partial,
  } as Evidence;
}

const scan = (time: string) =>
  evidence({ kind: "carrier_scan", status: "delivered", captured_at: at(time) });

const sawPackage = (time: string) =>
  evidence({ kind: "doorbell_event", event: "package_placed", captured_at: at(time) });

const sawPerson = (time: string) =>
  evidence({ kind: "doorbell_event", event: "person_detected", captured_at: at(time) });

function uptime(...ranges: Array<[string, string]>): ObservationWindow[] {
  return ranges.map(([start, end]) => ({
    source_id: "src_doorbell",
    household_id: HH,
    interval: interval(at(start), at(end)),
  }));
}

const assess = (args: {
  promise: OwedPromise;
  evidence?: Evidence[];
  uptime?: ObservationWindow[];
  now: string;
}) =>
  assessPromise({
    promise: args.promise,
    evidence: args.evidence ?? [],
    uptime: args.uptime ?? [],
    now: at(args.now),
  });

// ---------------------------------------------------------------------------

describe("phantom delivery", () => {
  const delivery = promise("delivery_window", {
    window: interval(at("12:00"), at("16:00")),
  });

  it("reproduces the storyboard: 82% coverage and 0.91 confidence", () => {
    const detection = assess({
      promise: delivery,
      evidence: [scan("14:12")],
      // The camera was up across the scan hour except 13:51-14:02.
      uptime: uptime(["13:42", "13:51"], ["14:02", "14:42"]),
      now: "18:00",
    });

    expect(detection?.kind).toBe("phantom_delivery");
    expect(detection?.verdict).toBe("Breached");
    expect(coveragePercent(detection?.coverage ?? 0)).toBe(82);
    expect(detection?.confidence).toBeCloseTo(0.91, 2);
  });

  it("evaluates the hour around the scan, not the whole delivery window", () => {
    const detection = assess({
      promise: delivery,
      evidence: [scan("14:12")],
      uptime: uptime(["13:42", "14:42"]),
      now: "18:00",
    });

    expect(detection?.evaluation_interval).toEqual(interval(at("13:42"), at("14:42")));
  });

  it("declines to claim when the camera was barely on", () => {
    // Scan inside the window, so nothing else is wrong with this delivery — the only
    // question is whether it really arrived, and the door cannot answer it.
    const detection = assess({
      promise: promise("delivery_window", { window: interval(at("14:00"), at("18:00")) }),
      evidence: [scan("16:40")],
      uptime: uptime(["16:20", "16:32"]),
      now: "19:00",
    });

    expect(coveragePercent(detection?.coverage ?? 0)).toBe(20);
    expect(detection?.verdict).toBe("Suspected");
  });

  it("trusts itself less when the scan itself fell in a gap", () => {
    const watched = assess({
      promise: delivery,
      evidence: [scan("14:12")],
      uptime: uptime(["13:42", "14:42"]),
      now: "18:00",
    });
    // Same total coverage, but the claimed moment is inside the unwatched stretch.
    const blind = assess({
      promise: delivery,
      evidence: [scan("14:12")],
      uptime: uptime(["13:42", "14:05"], ["14:20", "14:42"]),
      now: "18:00",
    });

    expect(blind?.confidence).toBeLessThan(watched?.confidence ?? 1);
  });

  it("says it was kept when the door saw the parcel arrive", () => {
    const detection = assess({
      promise: delivery,
      evidence: [scan("14:12"), sawPackage("14:13")],
      uptime: uptime(["13:42", "14:42"]),
      now: "18:00",
    });

    expect(detection?.verdict).toBe("Kept");
  });

  it("states what it did not see, in the explanation", () => {
    const detection = assess({
      promise: delivery,
      evidence: [scan("14:12")],
      uptime: uptime(["13:42", "13:51"], ["14:02", "14:42"]),
      now: "18:00",
    });

    expect(detection?.explanation).toContain("82%");
    expect(detection?.explanation).toContain("11 minutes unwatched");
  });
});

describe("missed window", () => {
  const delivery = promise("delivery_window", { window: interval(at("09:00"), at("13:00")) });

  it("is kept when the parcel arrives inside the window", () => {
    const detection = assess({
      promise: delivery,
      evidence: [scan("11:48"), sawPackage("11:48")],
      uptime: uptime(["09:00", "13:00"]),
      now: "14:00",
    });

    expect(detection?.verdict).toBe("Kept");
  });

  it("is breached when the parcel arrives after the window closes", () => {
    const detection = assess({
      promise: delivery,
      evidence: [scan("15:20"), sawPackage("15:20")],
      uptime: uptime(["09:00", "16:00"]),
      now: "16:00",
    });

    expect(detection?.kind).toBe("missed_window");
    expect(detection?.verdict).toBe("Breached");
    expect(detection?.explanation).toContain("140 minutes after the window closed");
  });

  it("trusts a carrier log completely — it has no gaps to have missed anything in", () => {
    const detection = assess({
      promise: delivery,
      evidence: [scan("15:20")],
      uptime: [],
      now: "16:00",
    });

    expect(detection?.coverage).toBe(1);
  });

  it("stays undecided while the window is still open", () => {
    const detection = assess({ promise: delivery, now: "10:00" });

    expect(detection?.verdict).toBe("Undetermined");
  });
});

describe("late eta", () => {
  const ride = promise("eta", { deadline: at("08:20") });

  it("is kept when the car arrives in time", () => {
    const detection = assess({
      promise: ride,
      evidence: [evidence({ kind: "timestamp", label: "arrived", captured_at: at("08:18") })],
      now: "09:00",
    });

    expect(detection?.verdict).toBe("Kept");
  });

  it("is breached, with the minutes stated, when it does not", () => {
    const detection = assess({
      promise: ride,
      evidence: [evidence({ kind: "timestamp", label: "arrived", captured_at: at("08:34") })],
      now: "09:00",
    });

    expect(detection?.verdict).toBe("Breached");
    expect(detection?.explanation).toContain("14 minutes after the promised time");
    expect(detection?.coverage).toBe(1);
  });
});

describe("late refund", () => {
  const refund = promise("refund_sla", { made_at: at("08:00"), deadline: at("12:00") });

  it("is breached when nothing has arrived past the promised date", () => {
    const detection = assess({ promise: refund, now: "18:00" });

    expect(detection?.kind).toBe("late_refund");
    expect(detection?.verdict).toBe("Breached");
    expect(detection?.confidence).toBe(1);
    expect(detection?.coverage).toBe(1);
  });

  it("is kept when the money arrives in time", () => {
    const detection = assess({
      promise: refund,
      evidence: [evidence({ kind: "refund_observed", amount: usd(112), captured_at: at("11:00") })],
      now: "18:00",
    });

    expect(detection?.verdict).toBe("Kept");
  });

  it("is not due yet before the promised date", () => {
    const detection = assess({ promise: refund, now: "10:00" });

    expect(detection?.verdict).toBe("Undetermined");
  });
});

describe("no show", () => {
  const appointment = promise("appointment_slot", {
    window: interval(at("13:00"), at("15:00")),
  });

  it("is breached when nobody comes", () => {
    const detection = assess({
      promise: appointment,
      uptime: uptime(["12:30", "15:30"]),
      now: "16:00",
    });

    expect(detection?.kind).toBe("no_show");
    expect(detection?.verdict).toBe("Breached");
  });

  it("is kept when somebody does", () => {
    const detection = assess({
      promise: appointment,
      evidence: [sawPerson("13:22")],
      uptime: uptime(["12:30", "15:30"]),
      now: "16:00",
    });

    expect(detection?.verdict).toBe("Kept");
  });

  it("will not claim when the door was hardly watched", () => {
    const detection = assess({
      promise: appointment,
      uptime: uptime(["13:00", "13:20"]),
      now: "16:00",
    });

    expect(detection?.verdict).toBe("Suspected");
  });
});

describe("price drop", () => {
  const priceMatch = promise("price_match", {
    window: interval(at("08:00"), at("20:00")),
    amount_at_stake: usd(89.99),
  });

  it("is breached when the price falls inside the window", () => {
    const detection = assess({
      promise: priceMatch,
      evidence: [
        evidence({ kind: "price_observed", amount: usd(74.99), captured_at: at("11:00") }),
      ],
      now: "12:00",
    });

    expect(detection?.kind).toBe("price_drop");
    expect(detection?.verdict).toBe("Breached");
    expect(detection?.explanation).toContain("$89.99");
    expect(detection?.explanation).toContain("$74.99");
  });

  it("is kept when it does not", () => {
    const detection = assess({
      promise: priceMatch,
      evidence: [evidence({ kind: "price_observed", amount: usd(92.5), captured_at: at("11:00") })],
      now: "21:00",
    });

    expect(detection?.verdict).toBe("Kept");
  });
});

/**
 * The boundary of the tolerance, which was unpinned in both directions.
 *
 * `TOLERANCE_MS` decided three different things at once, and two of them were the wrong
 * question. H2's only two failures lived here, and **nothing tested either shape** — no
 * assertion anywhere said what should happen to a sighting just outside the window, so the
 * behaviour was free to be wrong for as long as nobody ran the corpus.
 *
 * The tolerance itself is unchanged. What changed is which questions it is asked.
 */
describe("evidence outside the matching tolerance", () => {
  const delivery = promise("delivery_window", {
    window: interval(at("12:00"), at("16:00")),
  });
  const slot = promise("appointment_slot", {
    window: interval(at("13:00"), at("15:00")),
  });

  /**
   * The parcel is on the doorstep and there is a photograph of it arriving. Whether that
   * placement is "the same event" as the scan is a matching question; whether the parcel
   * was delivered is not, and the second is the one a claim rests on.
   */
  it("counts a placement 31 minutes after the scan as delivered", () => {
    const detection = assess({
      promise: delivery,
      evidence: [scan("14:00"), sawPackage("14:31")],
      uptime: uptime(["13:30", "15:00"]),
      now: "16:30",
    });

    expect(detection?.verdict).toBe("Kept");
    // And it says which it was, rather than overstating a match it did not have.
    expect(detection?.explanation).toContain("31 minutes from the scan");
  });

  it("still calls it a match when the placement is inside the tolerance", () => {
    const detection = assess({
      promise: delivery,
      evidence: [scan("14:00"), sawPackage("14:05")],
      uptime: uptime(["13:30", "15:00"]),
      now: "16:30",
    });

    expect(detection?.verdict).toBe("Kept");
    expect(detection?.explanation).toBe("The scan matches what the door recorded.");
  });

  /** The half that must not move: no sighting at all is still a phantom delivery. */
  it("still claims a phantom delivery when the door recorded nothing", () => {
    const detection = assess({
      promise: delivery,
      evidence: [scan("14:00")],
      uptime: uptime(["13:30", "14:30"]),
      now: "16:30",
    });

    expect(detection?.verdict).toBe("Breached");
    expect(detection?.kind).toBe("phantom_delivery");
  });

  /**
   * Twenty-nine minutes early, through the whole engine rather than one detector.
   *
   * This is the case that had three causes stacked on it. `noShow` admitted the sighting
   * and then judged it against the bare slot, so it reported `Breached` carrying the
   * explanation "Somebody arrived for the appointment." Underneath that, `missedWindow`
   * also applies to an appointment slot and read an early arrival as late — so fixing
   * `noShow` alone would have been masked by `assess` taking the more severe answer.
   */
  it("counts somebody arriving 29 minutes early as kept, through the whole engine", () => {
    const detection = assess({
      promise: slot,
      evidence: [sawPerson("12:31")],
      uptime: uptime(["12:30", "15:30"]),
      now: "16:00",
    });

    expect(detection?.verdict).toBe("Kept");
    // Whichever detector answers, it must not be a claim, and the sentence must agree
    // with the verdict.
    expect(detection?.explanation).not.toContain("Nobody arrived");
  });

  it("still claims a no-show when nobody arrived at all", () => {
    const detection = assess({
      promise: slot,
      evidence: [],
      uptime: uptime(["12:30", "15:30"]),
      now: "16:00",
    });

    expect(detection?.verdict).toBe("Breached");
    expect(detection?.kind).toBe("no_show");
  });
});

/**
 * A window is missed by being late. Arriving early is not missing it, and the giveaway
 * that the question was wrong was an explanation reading "Arrived -149 minutes after the
 * window closed."
 */
describe("early and late against a promised window", () => {
  const delivery = promise("delivery_window", {
    window: interval(at("13:00"), at("15:00")),
  });

  /**
   * `missedWindow` directly, not through `assess`.
   *
   * A `delivery_window` with a scan and no doorbell uptime is `Suspected` by
   * `phantomDelivery` — correctly: it cannot see the door, so it will not say the parcel
   * arrived and it will not claim it did not. That is the right answer to a different
   * question, and it outranks this one, so asking the engine here would test the severity
   * rule instead of the thing that was wrong.
   */
  const judge = (time: string) =>
    missedWindow.detect({
      promise: delivery,
      evidence: [scan(time)],
      uptime: [],
      now: at("23:30"),
    });

  it("does not claim a window was missed by a parcel that came early", () => {
    const detection = judge("12:30");

    expect(detection?.verdict).toBe("Kept");
    expect(detection?.explanation).toContain("30 minutes before the window opened");
  });

  it("still claims a window that was missed by a late arrival", () => {
    const detection = judge("15:45");

    expect(detection?.verdict).toBe("Breached");
    expect(detection?.explanation).toContain("45 minutes after the window closed");
  });

  /** The giveaway that the question was wrong: "Arrived -149 minutes after the window closed." */
  it("never reports a negative number of minutes", () => {
    for (const time of ["09:00", "12:59", "13:00", "15:00", "15:01", "23:00"]) {
      expect(judge(time)?.explanation, time).not.toMatch(/-\d+ minutes/);
    }
  });

  /** The closing instant is still inside. "Delivered by five" includes five. */
  it("counts an arrival at the closing instant as inside the window", () => {
    const detection = judge("15:00");

    expect(detection?.verdict).toBe("Kept");
    expect(detection?.explanation).toBe("Arrived inside the promised window.");
  });

  /** And one minute past it is not. The boundary is closed, so this is the first miss. */
  it("claims the window one minute after it closed", () => {
    expect(judge("15:01")?.verdict).toBe("Breached");
    expect(judge("15:01")?.explanation).toContain("1 minutes after the window closed");
  });
});

describe("the gate", () => {
  /**
   * The product's central safety promise, as a property rather than a paragraph:
   * nothing is ever reported as Breached below the confidence and coverage thresholds.
   */
  it("never reports Breached below the thresholds", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.constantFrom("kept" as const, "broken" as const, "unknown" as const),
        fc.boolean(),
        (confidence, coverage, outcome, decidable) => {
          const detection = conclude({
            promise: promise("delivery_window"),
            kind: "phantom_delivery",
            evaluation: interval(at("13:00"), at("14:00")),
            observed: watched(coverage),
            confidence,
            evidence_ids: [],
            explanation: "property test",
            outcome,
            decidable,
          });

          if (detection.verdict !== "Breached") return true;
          return confidence >= BREACH_CONFIDENCE_MIN && coverage >= BREACH_COVERAGE_MIN;
        },
      ),
      { numRuns: 500 },
    );
  });

  it("never claims before the moment of judgement has passed", () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 1, noNaN: true }), (coverage) => {
        const detection = conclude({
          promise: promise("delivery_window"),
          kind: "phantom_delivery",
          evaluation: interval(at("13:00"), at("14:00")),
          observed: watched(coverage),
          confidence: 1,
          evidence_ids: [],
          explanation: "property test",
          outcome: "broken",
          decidable: false,
        });

        return detection.verdict === "Undetermined";
      }),
      { numRuns: 200 },
    );
  });
});

/**
 * The invariant the evidence card rests on.
 *
 * A card that reported full coverage above four hours of "not watched" shipped because
 * the number and the gaps came from different places: coverage from the detector, the
 * gaps reconstructed from the household's camera timeline. They are now read from the
 * one field, and these properties say what that buys.
 */
describe("what a detection says it saw", () => {
  const evaluation = interval(at("13:00"), at("15:00"));
  const minutes = (n: number) => fromEpochMs(toEpochMs(at("13:00")) + n * 60_000);

  /** Spans anywhere from an hour before the interval to an hour after it. */
  const spans = fc.array(
    fc
      .tuple(fc.integer({ min: -60, max: 180 }), fc.integer({ min: -60, max: 180 }))
      .map(([a, b]): Interval => interval(minutes(Math.min(a, b)), minutes(Math.max(a, b) + 1))),
    { maxLength: 6 },
  );

  const detectionFrom = (observed: readonly Interval[]) =>
    conclude({
      promise: promise("delivery_window"),
      kind: "phantom_delivery",
      evaluation,
      observed,
      confidence: 0.9,
      evidence_ids: [],
      explanation: "property test",
      outcome: "broken",
      decidable: true,
    });

  it("tiles the evaluated window exactly, with the gaps the card draws", () => {
    fc.assert(
      fc.property(spans, (observed) => {
        const detection = detectionFrom(observed);
        const gaps = coverageGaps(detection.observed, detection.evaluation_interval);
        expect(measuredMs(detection.observed) + measuredMs(gaps)).toBe(durationMs(evaluation));
      }),
      { numRuns: 400 },
    );
  });

  it("reports a coverage the same stretches add up to", () => {
    fc.assert(
      fc.property(spans, (observed) => {
        const detection = detectionFrom(observed);
        expect(measuredMs(detection.observed) / durationMs(evaluation)).toBeCloseTo(
          detection.coverage,
          10,
        );
      }),
      { numRuns: 400 },
    );
  });

  it("never claims to have seen anything outside the window it judged", () => {
    fc.assert(
      fc.property(spans, (observed) => {
        for (const seen of detectionFrom(observed).observed) {
          expect(toEpochMs(seen.start)).toBeGreaterThanOrEqual(toEpochMs(evaluation.start));
          expect(toEpochMs(seen.end)).toBeLessThanOrEqual(toEpochMs(evaluation.end));
        }
      }),
      { numRuns: 400 },
    );
  });
});
