import {
  type Detection,
  type Instant,
  type Interval,
  type OwedPromise,
  PromiseKindSchema,
} from "@owed/domain";
import { describe, expect, it } from "vitest";
import { DETECTORS, derivedBreach, derivesFromSiblings } from "./detectors.js";
import { assessPromise, watchable } from "./engine.js";
import { conclude, type SiblingVerdict } from "./types.js";

const HH = "hh_kinds";
const at = (hhmm: string): Instant => `2026-10-06T${hhmm}:00-07:00`;
const span = (from: string, to: string): Interval => ({ start: at(from), end: at(to) });

/** Every optional field filled, so a kind that matches nothing matches nothing on merit. */
function promise(kind: OwedPromise["kind"], extra: Partial<OwedPromise> = {}): OwedPromise {
  return {
    id: `prm_${kind}`,
    household_id: HH,
    merchant: "Northwind Parcel",
    source_ref: "msg_1",
    source_quote: "Delivered between one and five, guaranteed or your money back.",
    kind,
    made_at: at("09:00"),
    currency: "USD",
    confidence: 0.95,
    status: "Captured",
    window: span("13:00", "17:00"),
    deadline: at("17:00"),
    amount_at_stake: { minor: 1200, currency: "USD" },
    ...extra,
  };
}

/**
 * Nothing may be declared and left unwatched.
 *
 * `PromiseKindSchema` has had seven members since the schema froze, and `appliesTo` covered
 * five: `guarantee` and `warranty` were extractable — `eval/results/extraction.json` publishes
 * precision and recall for both — written into the ledger, and never judged. `assessPromise`
 * returned `undefined`, `speakPromiseCheck` fell through to "I'm still watching", and the only
 * reason the seeded week never contained one is that `seed/build.ts` throws when nothing
 * produces a verdict.
 *
 * **Deliberately no exemption list.** A test that let a kind opt out of being watched would
 * have passed throughout the period this is written to prevent. If an eighth kind is added,
 * this fails until something covers it.
 */
describe("every promise kind the schema declares", () => {
  for (const kind of PromiseKindSchema.options) {
    it(`has a detector that covers ${kind}`, () => {
      const covering = DETECTORS.filter((detector) => detector.appliesTo(promise(kind)));
      expect(
        covering.map((d) => d.kind),
        `nothing covers ${kind}`,
      ).not.toStrictEqual([]);
      expect(watchable(promise(kind))).toBe(true);
    });
  }

  it("covers all seven, counted rather than assumed", () => {
    expect(PromiseKindSchema.options).toHaveLength(7);
    const unwatched = PromiseKindSchema.options.filter((kind) => !watchable(promise(kind)));
    expect(unwatched).toStrictEqual([]);
  });
});

/**
 * `watchable` is per-promise, not per-kind, and that is the point.
 *
 * A weakly-read `eta` with no deadline has nothing to be late against, so no detector covers
 * it however well-known its kind is. That is the class the honest spoken line is for now that
 * all seven kinds have a detector.
 */
describe("a promise too weakly read to judge", () => {
  it("is not watchable when the field its detector needs is missing", () => {
    const bare = promise("eta", { window: undefined, deadline: undefined });
    expect(watchable(bare)).toBe(false);
    expect(
      assessPromise({ promise: bare, evidence: [], uptime: [], now: at("20:00") }),
    ).toBeUndefined();
  });
});

const breachedSibling = (kind: OwedPromise["kind"], breach: Detection["kind"]): SiblingVerdict => {
  const sibling = promise(kind, { id: "prm_sibling" });
  return {
    promise: sibling,
    detection: conclude({
      promise: sibling,
      kind: breach,
      evaluation: span("13:00", "17:00"),
      observed: [span("13:00", "17:00")],
      confidence: 1,
      evidence_ids: ["evd_1"],
      explanation: "nobody came to the door.",
      outcome: "broken",
      decidable: true,
    }),
  };
};

describe("a guarantee, which has no evidence of its own", () => {
  it("inherits the breach kind of the promise it covers, rather than inventing one", () => {
    const guarantee = promise("guarantee", { id: "prm_g" });
    const detection = assessPromise({
      promise: guarantee,
      evidence: [],
      uptime: [],
      now: at("20:00"),
      siblings: [breachedSibling("delivery_window", "missed_window")],
    });

    expect(detection?.verdict).toBe("Breached");
    // The six frozen breach kinds stay six: contract-v1.md §1.
    expect(detection?.kind).toBe("missed_window");
  });

  it("abstains with no sibling to derive from, rather than guessing Kept", () => {
    expect(
      assessPromise({
        promise: promise("guarantee", { id: "prm_g" }),
        evidence: [],
        uptime: [],
        now: at("20:00"),
      }),
    ).toBeUndefined();
  });

  it("ignores a promise from a different message", () => {
    const elsewhere = breachedSibling("delivery_window", "missed_window");
    elsewhere.promise = { ...elsewhere.promise, source_ref: "msg_other" };

    expect(
      assessPromise({
        promise: promise("guarantee", { id: "prm_g" }),
        evidence: [],
        uptime: [],
        now: at("20:00"),
        siblings: [elsewhere],
      }),
    ).toBeUndefined();
  });

  /**
   * A derived verdict cannot be better evidenced than what it derives from, so the gates
   * apply to it unchanged: a guarantee over a breach Owed could not see enough of is not
   * claimable either.
   */
  it("inherits coverage rather than asserting its own", () => {
    const thin = breachedSibling("delivery_window", "missed_window");
    thin.detection = { ...thin.detection, coverage: 0.2, verdict: "Suspected" };

    const detection = assessPromise({
      promise: promise("guarantee", { id: "prm_g" }),
      evidence: [],
      uptime: [],
      now: at("20:00"),
      siblings: [thin],
    });

    expect(detection?.verdict).not.toBe("Breached");
  });

  it("is the one kind family whose verdict is derived", () => {
    expect(derivesFromSiblings(promise("guarantee"))).toBe(true);
    expect(derivesFromSiblings(promise("warranty"))).toBe(true);
    for (const kind of PromiseKindSchema.options) {
      if (kind === "guarantee" || kind === "warranty") continue;
      expect(derivesFromSiblings(promise(kind)), kind).toBe(false);
    }
    expect(derivedBreach.appliesTo(promise("delivery_window"))).toBe(false);
  });
});
