import type { Money, RecourseMessage } from "@owed/recourse-protocol";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { nextAction, openingAsk, type RemedyBounds, standingOffer } from "./negotiator.js";

const usd = (major: number): Money => ({ minor: Math.round(major * 100), currency: "USD" });

/** Northwind's Delivery Guarantee 4.2: they publish $12, their wording allows $15. */
const BOUNDS: RemedyBounds = {
  reservation: usd(12),
  ceiling: usd(15),
  clause: { id: "northwind/delivery-guarantee#4.2", title: "Delivery Guarantee 4.2" },
};

const claim: RecourseMessage = {
  type: "CLAIM",
  claim_id: "clm_1",
  at: "2026-01-02T18:00:00.000Z",
  promise: {
    id: "prm_1",
    kind: "delivery_window",
    merchant: "Northwind Parcel",
    made_at: "2026-01-01T00:00:00.000Z",
  },
  breach_kind: "phantom_delivery",
  evidence_pack: {
    items: [],
    coverage: 0.82,
    evaluation_interval: { start: "2026-01-02T13:42:00.000Z", end: "2026-01-02T14:42:00.000Z" },
  },
  ask: usd(15),
};

/** Build a transcript from a sequence of offers, countering between each. */
function transcriptOf(offerMajors: readonly number[]): RecourseMessage[] {
  const messages: RecourseMessage[] = [claim];
  offerMajors.forEach((major, index) => {
    messages.push({
      type: "OFFER",
      claim_id: "clm_1",
      at: "2026-01-02T18:01:00.000Z",
      amount: usd(major),
      form: "credit",
    });
    if (index < offerMajors.length - 1) {
      messages.push({
        type: "COUNTER",
        claim_id: "clm_1",
        at: "2026-01-02T18:02:00.000Z",
        amount: usd(12),
        justification: { policy_clause: "Delivery Guarantee 4.2", evidence_ids: [] },
      });
    }
  });
  return messages;
}

describe("the opening ask", () => {
  it("is the most the merchant's own wording allows, and no more", () => {
    expect(openingAsk(BOUNDS)).toEqual(usd(15));
  });
});

describe("nextAction", () => {
  it("accepts an offer at the published figure", () => {
    expect(nextAction(transcriptOf([12]), { bounds: BOUNDS }).type).toBe("ACCEPT");
  });

  it("accepts an offer above it without haggling for more", () => {
    expect(nextAction(transcriptOf([14]), { bounds: BOUNDS }).type).toBe("ACCEPT");
  });

  it("counters a lowball at exactly what the merchant published", () => {
    const action = nextAction(transcriptOf([5]), { bounds: BOUNDS });

    expect(action.type).toBe("COUNTER");
    if (action.type !== "COUNTER") return;
    expect(action.amount).toEqual(usd(12));
    expect(action.justification.policy_clause).toBe("Delivery Guarantee 4.2");
  });

  it("takes what is on the table at the round cap rather than making a point", () => {
    const action = nextAction(transcriptOf([5, 6, 7]), { bounds: BOUNDS, maxRounds: 3 });

    expect(action.type).toBe("ACCEPT");
  });

  it("escalates when the merchant has withdrawn to nothing", () => {
    const action = nextAction(transcriptOf([5, 0, 0]), { bounds: BOUNDS, maxRounds: 3 });

    expect(action.type).toBe("ESCALATE");
  });

  it("reads the offer on the table, not the best one ever seen", () => {
    expect(standingOffer(transcriptOf([9, 0]))?.amount).toEqual(usd(0));
  });
});

describe("the safety invariants", () => {
  /**
   * The clause title is generated, not a constant.
   *
   * It used to be `title: "Clause"` for every case, which made *"always cites a clause when
   * it counters"* an assertion that a hard-coded string is non-empty. A generated title lets
   * the property say the thing it means: the counter cites **this** merchant's clause,
   * verbatim, rather than any non-empty string the negotiator might have had lying around.
   */
  const boundsArb = fc
    .record({
      reservationMinor: fc.integer({ min: 0, max: 50_000 }),
      headroom: fc.integer({ min: 0, max: 20_000 }),
      title: fc.string({ minLength: 1, maxLength: 40 }).filter((s) => s.trim().length > 0),
    })
    .map(
      ({ reservationMinor, headroom, title }): RemedyBounds => ({
        reservation: { minor: reservationMinor, currency: "USD" },
        ceiling: { minor: reservationMinor + headroom, currency: "USD" },
        clause: { id: "c", title },
      }),
    );

  /**
   * Offers that can actually provoke a counter, which the old ones mostly could not.
   *
   * Two separate mistakes, and both were invisible until the runs were counted.
   *
   * `transcriptOf` takes majors and `usd` multiplies by a hundred, so `max: 1000` meant
   * offers spanning 0 to 100,000 minor against a reservation spanning 0 to 50,000, and
   * `nextAction` ACCEPTs as soon as the standing offer reaches the reservation. Then
   * `maxLength: 6`: `countRounds` reaches `MAX_NEGOTIATION_ROUNDS` (3) at the third offer,
   * so a transcript of four or more could never produce a COUNTER at all — four of the six
   * generated lengths were incapable of reaching the assertion.
   *
   * Measured over eight repetitions, the old pair reached a COUNTER in **60 to 109 of 1000
   * runs** — under one run in ten, and none of those could fail. `max: 500` matches the
   * reservation's range and `maxLength: 3` keeps the one length that still exercises the
   * round cap: 301 to 338 of 1000. The `countered` assertions below pin that, so a future
   * change that quietly stops reaching the invariant fails instead of passing.
   */
  const offersArb = fc.array(fc.integer({ min: 0, max: 500 }), { minLength: 1, maxLength: 3 });

  /**
   * The product's answer to "what is your legal exposure?", as a property rather than a
   * paragraph: Owed never asks a merchant for more than that merchant's own published
   * wording allows.
   */
  it("never asks for more than the merchant's own wording allows", () => {
    let countered = 0;
    fc.assert(
      fc.property(
        boundsArb,
        offersArb,
        fc.integer({ min: 1, max: 5 }),
        (bounds, offers, maxRounds) => {
          const action = nextAction(transcriptOf(offers), { bounds, maxRounds });
          if (action.type !== "COUNTER") return true;
          countered += 1;
          return action.amount.minor <= bounds.ceiling.minor;
        },
      ),
      { numRuns: 1000 },
    );

    // Lower than the properties that take the default cap: this one generates `maxRounds`
    // down to 1, which blocks the counter outright.
    expect(countered, "runs that reached the invariant").toBeGreaterThan(100);
  });

  it("never undercuts what the merchant published either", () => {
    let countered = 0;
    fc.assert(
      fc.property(boundsArb, offersArb, (bounds, offers) => {
        const action = nextAction(transcriptOf(offers), { bounds });
        if (action.type !== "COUNTER") return true;
        countered += 1;
        return action.amount.minor >= bounds.reservation.minor;
      }),
      { numRuns: 1000 },
    );

    expect(countered, "runs that reached the invariant").toBeGreaterThan(200);
  });

  /**
   * The margins, which nothing ships with.
   *
   * Both default to zero, and the properties above still assert the shipped invariants
   * verbatim — including *"never undercuts what the merchant published either"* — because
   * they pass no margin. Weakening those assertions to accommodate an option no caller sets
   * would have traded a named guarantee for a measurement, so the margin gets its own
   * property instead.
   *
   * These three example tests are what actually holds the default in place, and it is worth
   * being precise about that: the property above compares the counter to the reservation,
   * and with no margin `below` returns its argument unchanged, so the two sides are the same
   * expression. It would catch a changed default — raise `counterMargin` to 0.025 and it
   * goes red — but it is not an independent check. The three below are.
   *
   * They exist because `eval/README.md` predicted that conceding a little would buy a lot of
   * robustness, and a prediction in a submission has to be answerable.
   * `eval/src/bin/robustness.ts` answers it: for `counterMargin`, the lever that was
   * predicted, the trade is roughly one-for-one and never restores the result.
   */
  it("counters below the published figure only when asked to, and by exactly the margin", () => {
    const none = nextAction(transcriptOf([5]), { bounds: BOUNDS });
    const tenth = nextAction(transcriptOf([5]), { bounds: BOUNDS, counterMargin: 0.1 });

    if (none.type !== "COUNTER" || tenth.type !== "COUNTER") throw new Error("expected counters");
    expect(none.amount).toEqual(usd(12));
    expect(tenth.amount).toEqual(usd(10.8));
  });

  it("settles for less than the published figure only within the margin it was given", () => {
    // $11 against a published $12 is an 8.3% shortfall.
    const transcript = transcriptOf([11]);

    expect(nextAction(transcript, { bounds: BOUNDS }).type).toBe("COUNTER");
    expect(nextAction(transcript, { bounds: BOUNDS, acceptMargin: 0.05 }).type).toBe("COUNTER");
    expect(nextAction(transcript, { bounds: BOUNDS, acceptMargin: 0.1 }).type).toBe("ACCEPT");
  });

  it("treats a zero margin as no margin at all", () => {
    for (const options of [
      { bounds: BOUNDS },
      { bounds: BOUNDS, acceptMargin: 0, counterMargin: 0 },
    ]) {
      const action = nextAction(transcriptOf([5]), options);
      if (action.type !== "COUNTER") throw new Error("expected a counter");
      expect(action.amount).toEqual(usd(12));
    }
  });

  /**
   * Both ends of the clamp, which nothing exercised.
   *
   * `below` does `Math.min(Math.max(margin, 0), 1)` and both branches are live code reachable
   * from a caller's argument. The property below asserts the counter is never negative, and
   * cannot fail — the clamp and a non-negative reservation each guarantee it independently.
   * This says what that property was reaching for, in the falsifiable direction: what the
   * clamp actually *does* at either end.
   *
   * The asymmetry is the point. A margin over 1 would counter below nothing, so it pins to
   * zero. A negative margin would counter *above* the published figure, which is the one
   * thing the stance forbids, so it pins to the figure itself.
   */
  it("clamps a margin outside the range it means, instead of inventing a number", () => {
    const counterAt = (counterMargin: number) => {
      const action = nextAction(transcriptOf([5]), { bounds: BOUNDS, counterMargin });
      if (action.type !== "COUNTER") throw new Error("expected a counter");
      return action.amount;
    };

    expect(counterAt(1)).toEqual(usd(0));
    expect(counterAt(4)).toEqual(usd(0));
    expect(counterAt(-0.5)).toEqual(usd(12));
    expect(counterAt(-200)).toEqual(usd(12));
  });

  it("stays between the margin and the ceiling, whatever the bounds", () => {
    let countered = 0;
    fc.assert(
      fc.property(
        boundsArb,
        offersArb,
        fc.double({ min: 0, max: 0.5, noNaN: true }),
        (bounds, offers, margin) => {
          const action = nextAction(transcriptOf(offers), { bounds, counterMargin: margin });
          if (action.type !== "COUNTER") return true;
          countered += 1;
          const floor = Math.round(bounds.reservation.minor * (1 - margin));
          return action.amount.minor >= floor && action.amount.minor <= bounds.ceiling.minor;
        },
      ),
      { numRuns: 500 },
    );

    expect(countered, "runs that reached the invariant").toBeGreaterThan(100);
  });

  /** A margin can never turn an ask into a debt, however absurd the value. */
  it("never counters below nothing", () => {
    let countered = 0;
    fc.assert(
      fc.property(boundsArb, fc.double({ min: -5, max: 5, noNaN: true }), (bounds, margin) => {
        const action = nextAction(transcriptOf([0]), { bounds, counterMargin: margin });
        if (action.type !== "COUNTER") return true;
        countered += 1;
        return action.amount.minor >= 0;
      }),
      { numRuns: 500 },
    );

    expect(countered, "runs that reached the invariant").toBeGreaterThan(100);
  });

  it("always cites a clause when it counters — never an unsupported number", () => {
    let countered = 0;
    fc.assert(
      fc.property(boundsArb, offersArb, (bounds, offers) => {
        const action = nextAction(transcriptOf(offers), { bounds });
        if (action.type !== "COUNTER") return true;
        countered += 1;
        // The generated title, verbatim. Non-emptiness was all this asserted while every
        // case carried the same constant, and non-emptiness is not the claim.
        return action.justification.policy_clause === bounds.clause.title;
      }),
      { numRuns: 500 },
    );

    expect(countered, "runs that reached the invariant").toBeGreaterThan(100);
  });
});
