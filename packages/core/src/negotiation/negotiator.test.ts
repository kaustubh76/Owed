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
  const boundsArb = fc
    .record({
      reservationMinor: fc.integer({ min: 0, max: 50_000 }),
      headroom: fc.integer({ min: 0, max: 20_000 }),
    })
    .map(
      ({ reservationMinor, headroom }): RemedyBounds => ({
        reservation: { minor: reservationMinor, currency: "USD" },
        ceiling: { minor: reservationMinor + headroom, currency: "USD" },
        clause: { id: "c", title: "Clause" },
      }),
    );

  const offersArb = fc.array(fc.integer({ min: 0, max: 1000 }), { minLength: 1, maxLength: 6 });

  /**
   * The product's answer to "what is your legal exposure?", as a property rather than a
   * paragraph: Owed never asks a merchant for more than that merchant's own published
   * wording allows.
   */
  it("never asks for more than the merchant's own wording allows", () => {
    fc.assert(
      fc.property(
        boundsArb,
        offersArb,
        fc.integer({ min: 1, max: 5 }),
        (bounds, offers, maxRounds) => {
          const action = nextAction(transcriptOf(offers), { bounds, maxRounds });
          if (action.type !== "COUNTER") return true;
          return action.amount.minor <= bounds.ceiling.minor;
        },
      ),
      { numRuns: 1000 },
    );
  });

  it("never undercuts what the merchant published either", () => {
    fc.assert(
      fc.property(boundsArb, offersArb, (bounds, offers) => {
        const action = nextAction(transcriptOf(offers), { bounds });
        if (action.type !== "COUNTER") return true;
        return action.amount.minor >= bounds.reservation.minor;
      }),
      { numRuns: 1000 },
    );
  });

  it("always cites a clause when it counters — never an unsupported number", () => {
    fc.assert(
      fc.property(boundsArb, offersArb, (bounds, offers) => {
        const action = nextAction(transcriptOf(offers), { bounds });
        if (action.type !== "COUNTER") return true;
        return action.justification.policy_clause.trim().length > 0;
      }),
      { numRuns: 500 },
    );
  });
});
