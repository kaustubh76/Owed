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
  failedBreachGate,
  fromEpochMs,
  interval,
  meetsBreachGate,
  toEpochMs,
  usd,
} from "@owed/domain";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { coverageGaps, measuredMs } from "../evidence/coverage.js";
import { missedWindow } from "./detectors.js";
import { assessPromise } from "./engine.js";
import { conclude, confidenceFromCoverage } from "./types.js";

const HH = "hh_test";

/**
 * The promise every fixture here is about.
 *
 * Named because the evidence helper has to tag with it: `assessPromise` admits only
 * evidence carrying this promise's id, so a fixture that omitted the field — which all of
 * them used to — would hand the detectors an empty array and quietly test nothing.
 */
const PROMISE_ID = "prm_1";
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
    id: PROMISE_ID,
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
    promise_id: PROMISE_ID,
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

/**
 * Whose evidence is whose.
 *
 * `promise_id` is optional on every evidence variant, and `assessPromise` used to admit
 * anything that omitted it — so one untagged doorbell event was visible to every promise in
 * the household. Nothing produces untagged evidence and the ledger projection drops it, so
 * the clause had no live purpose; what it had was a latent hazard that got worse when
 * `phantomDelivery` and `noShow` stopped windowing their sighting lookup. An untagged
 * sighting then only had to exist to clear a promise it was never about.
 *
 * The direction matters. A false positive argues with a merchant and gets found out. This
 * one tells the household nothing, about money they are owed.
 */
describe("evidence belonging to another promise", () => {
  const delivery = promise("delivery_window", {
    window: interval(at("12:00"), at("16:00")),
  });

  /** Built deliberately without the field, which the helper above always sets. */
  const untagged = (partial: EvidenceDraft): Evidence => {
    const { promise_id: _dropped, ...rest } = evidence(partial) as Evidence & {
      promise_id?: string;
    };
    return rest as Evidence;
  };

  it("does not let an untagged sighting clear a promise it was never about", () => {
    const scanned = scan("14:00");
    const strayPlacement = untagged({
      kind: "doorbell_event",
      event: "package_placed",
      captured_at: at("14:05"),
    });

    expect(strayPlacement.promise_id).toBeUndefined();
    const detection = assess({
      promise: delivery,
      evidence: [scanned, strayPlacement],
      uptime: uptime(["13:30", "15:00"]),
      now: "16:30",
    });

    // The door recorded something, but not about this promise. The parcel is still a
    // phantom as far as this promise's evidence goes.
    expect(detection?.verdict).toBe("Breached");
    expect(detection?.kind).toBe("phantom_delivery");
  });

  it("does not let another promise's sighting clear this one either", () => {
    const otherPromise = evidence({
      kind: "doorbell_event",
      event: "package_placed",
      captured_at: at("14:05"),
      promise_id: "prm_somebody_else",
    });

    const detection = assess({
      promise: delivery,
      evidence: [scan("14:00"), otherPromise],
      uptime: uptime(["13:30", "15:00"]),
      now: "16:30",
    });

    expect(detection?.verdict).toBe("Breached");
  });

  it("still clears it on a sighting that is actually its own", () => {
    const detection = assess({
      promise: delivery,
      evidence: [scan("14:00"), sawPackage("14:05")],
      uptime: uptime(["13:30", "15:00"]),
      now: "16:30",
    });

    expect(detection?.verdict).toBe("Kept");
  });

  /** And the same for an appointment: somebody else's visitor is not your engineer. */
  it("does not let an untagged visitor answer an appointment", () => {
    const slot = promise("appointment_slot", {
      window: interval(at("13:00"), at("15:00")),
    });

    const detection = assess({
      promise: slot,
      evidence: [
        untagged({ kind: "doorbell_event", event: "person_detected", captured_at: at("13:30") }),
      ],
      uptime: uptime(["12:30", "15:30"]),
      now: "16:00",
    });

    expect(detection?.verdict).toBe("Breached");
    expect(detection?.kind).toBe("no_show");
  });
});

describe("the gate", () => {
  /**
   * Fractions that visit the region the gate actually turns on.
   *
   * The uniform draw is kept and a second branch added either side of the threshold — so
   * the support is unchanged and nothing that used to be generated stopped being
   * generated. This widens; it does not narrow. Needed because the property below has to
   * clear *both* gates to reach its assertion, and two independent uniform draws over
   * [0, 1] do that about one time in five before the outcome and decidability filters
   * take their share.
   */
  const fractionAround = (threshold: number) =>
    fc.oneof(
      fc.double({ min: 0, max: 1, noNaN: true }),
      fc.double({
        min: Math.max(0, threshold - 0.1),
        max: Math.min(1, threshold + 0.1),
        noNaN: true,
      }),
    );

  /**
   * The product's central safety promise, as a property rather than a paragraph:
   * nothing is ever reported as Breached below the confidence and coverage thresholds.
   *
   * `gated` is counted because almost nothing reached the assertion. A case has to be
   * `broken` (one outcome in three), `decidable` (one in two), *and* clear both gates, and
   * the result was a handful of reaching runs out of five hundred. The property was still
   * doing something — which is why it is worth making it reach rather than merely
   * measuring it. The assertion is not a tautology: `coverage` is the fraction the case
   * asked for, while the gate reads the coverage `conclude` re-derives from the intervals
   * `watched()` built from it, so the two agreeing is a real invariant about coverage
   * derivation. It was being checked a couple of times per run.
   */
  it("never reports Breached below the thresholds", () => {
    let gated = 0;
    fc.assert(
      fc.property(
        fractionAround(BREACH_CONFIDENCE_MIN),
        fractionAround(BREACH_COVERAGE_MIN),
        // Weighted, not narrowed: all three outcomes and both booleans are still drawn,
        // just not uniformly. Only a `broken` and `decidable` case can be Breached at all,
        // so a uniform draw spends five sixths of its runs on the early return.
        fc.oneof(
          {
            arbitrary: fc.constantFrom("kept" as const, "broken" as const, "unknown" as const),
            weight: 1,
          },
          { arbitrary: fc.constant("broken" as const), weight: 3 },
        ),
        fc.oneof(
          { arbitrary: fc.boolean(), weight: 1 },
          { arbitrary: fc.constant(true), weight: 3 },
        ),
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
          gated += 1;
          return confidence >= BREACH_CONFIDENCE_MIN && coverage >= BREACH_COVERAGE_MIN;
        },
      ),
      { numRuns: 2000 },
    );

    // 88 to 115 of 2000 measured over six runs; 40 leaves better than twice the margin.
    // Before the widening and the weights it was 3 to 9 of 500 — about five assertions a
    // run, on the property that states the product's main promise.
    expect(gated, "runs that reached the gate").toBeGreaterThan(40);
  });

  /**
   * Undecidable abstains — and decidable does not.
   *
   * This property used to hardcode `decidable: false` and vary only `coverage`, which
   * `verdictFor` does not consult when a case is undecidable. Two hundred runs, all
   * asserting the same thing, and no way to tell the real implementation from one that
   * returns `"Undetermined"` for everything. The arbitrary bought nothing.
   *
   * So `decidable` is the generated parameter now, and the assertion runs both ways. The
   * second half is what gives the first half meaning: an implementation that always
   * abstained would satisfy "undecidable ⇒ Undetermined" perfectly.
   */
  it("abstains before the moment of judgement, and only before it", () => {
    let undecided = 0;
    let decided = 0;
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.boolean(),
        (coverage, decidable) => {
          const detection = conclude({
            promise: promise("delivery_window"),
            kind: "phantom_delivery",
            evaluation: interval(at("13:00"), at("14:00")),
            observed: watched(coverage),
            confidence: 1,
            evidence_ids: [],
            explanation: "property test",
            outcome: "broken",
            decidable,
          });

          if (!decidable) {
            undecided += 1;
            // Whatever the coverage. This is the half that was already here.
            return detection.verdict === "Undetermined";
          }

          decided += 1;
          // And the half that was not: a decidable case reaches a real verdict. Which one
          // depends on coverage and is the gate property's business, not this one's — but
          // it is never the abstention.
          return detection.verdict !== "Undetermined";
        },
      ),
      { numRuns: 400 },
    );

    expect(undecided, "undecidable cases generated").toBeGreaterThan(50);
    expect(decided, "decidable cases generated").toBeGreaterThan(50);
  });

  /**
   * `failedBreachGate` is the same gate, read backwards.
   *
   * It exists so a refusal can name the number that refused instead of assuming it was the
   * window, and the one thing it must never do is disagree with the gate it explains — a
   * sentence blaming a gate that passed is worse than the generic one it replaced.
   */
  it("names a failing gate exactly when the gate refuses", () => {
    const fractions = [0, 0.3, 0.5, 0.69, 0.7, 0.71, 0.84, 0.85, 0.86, 0.95, 1];
    for (const confidence of fractions) {
      for (const coverage of fractions) {
        expect(
          failedBreachGate(confidence, coverage) === undefined,
          `confidence ${confidence}, coverage ${coverage}`,
        ).toBe(meetsBreachGate(confidence, coverage));
      }
    }
  });

  /**
   * The coincidence three spoken sentences used to rest on, now stated and enforced.
   *
   * The absence detectors derive confidence from coverage, and
   * `confidenceFromCoverage(BREACH_COVERAGE_MIN)` lands **exactly** on
   * `BREACH_CONFIDENCE_MIN` — so for those detections the two gates fail together, and the
   * coverage sentence has always been the true reason. Nothing said so: three independently
   * chosen constants happened to agree, and `GAP_CREDIBILITY`'s own comment justifies 0.5 by
   * what a gap can hide without mentioning the threshold it lands on.
   *
   * `claim_file`'s refusal no longer depends on this — it asks which gate failed. These two
   * still do, because the views they read carry `coverage` and not `confidence`:
   *
   *   voice.ts `speakDeclined`      "There's one I'm not claiming, because I only watched …"
   *   voice.ts `speakPromiseCheck`  "I'm not claiming …. I watched … percent of the window."
   *
   * So if this fails, the calibration moved and those two sentences can now blame a window
   * that was fine. Re-calibrate, or give those views a confidence field and ask
   * `failedBreachGate` the way `claim_file` does.
   */
  it("is calibrated so a coverage-derived detection fails both gates together", () => {
    expect(confidenceFromCoverage(BREACH_COVERAGE_MIN)).toBe(BREACH_CONFIDENCE_MIN);

    const disagreed: string[] = [];
    for (let step = 0; step <= 100; step += 1) {
      const coverage = step / 100;
      const byCoverage = coverage >= BREACH_COVERAGE_MIN;
      const byConfidence = confidenceFromCoverage(coverage) >= BREACH_CONFIDENCE_MIN;
      if (byCoverage !== byConfidence) disagreed.push(coverage.toFixed(2));
    }

    expect(
      disagreed,
      "the two gates no longer agree for coverage-derived detections, so `speakDeclined` and " +
        "`speakPromiseCheck` can now blame a window that passed — see this test's comment",
    ).toStrictEqual([]);
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

  /**
   * `checked` is the point, not decoration.
   *
   * `spans` has no `minLength`, so `[]` is generated often and is also what fast-check
   * shrinks towards; a span drawn entirely from the hour *before* the window is clipped away
   * by `observedWithin` too. Either way the loop body never runs and the property passes
   * having asserted nothing. The two tiling properties above want those degenerate cases —
   * "no sightings tile to one gap the width of the window" is a real claim — so the
   * arbitrary stays as it is and this one counts the stretches it actually inspected
   * instead.
   */
  it("never claims to have seen anything outside the window it judged", () => {
    let checked = 0;
    fc.assert(
      fc.property(spans, (observed) => {
        for (const seen of detectionFrom(observed).observed) {
          checked += 1;
          expect(toEpochMs(seen.start)).toBeGreaterThanOrEqual(toEpochMs(evaluation.start));
          expect(toEpochMs(seen.end)).toBeLessThanOrEqual(toEpochMs(evaluation.end));
        }
      }),
      { numRuns: 400 },
    );

    expect(checked, "stretches the property actually inspected").toBeGreaterThan(100);
  });
});
