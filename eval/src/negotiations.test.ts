import { createNegotiator, openingAsk } from "@owed/core";
import {
  createMerchantAgent,
  type MerchantBehaviour,
  storyboardMerchant,
} from "@owed/merchant-agents";
import { type BreachKind, builtinPolicies, type Money, remedyFor } from "@owed/policy-library";
import { type ClaimMessage, runSession } from "@owed/recourse-protocol";
import { describe, expect, it } from "vitest";

const usd = (major: number): Money => ({ minor: Math.round(major * 100), currency: "USD" });
const library = builtinPolicies();

interface NegotiationOptions {
  merchant: string;
  breachKind: BreachKind;
  shortfall?: Money;
  behaviour?: Partial<MerchantBehaviour>;
}

/** Drive a real negotiation between the real negotiator and a real merchant agent. */
async function negotiate({ merchant, breachKind, shortfall, behaviour }: NegotiationOptions) {
  const policy = library.get(merchant);
  if (!policy) throw new Error(`no policy for ${merchant}`);

  const remedy = remedyFor(policy, breachKind, shortfall === undefined ? {} : { shortfall });
  if (!remedy) throw new Error(`no remedy for ${breachKind} at ${merchant}`);

  const config = storyboardMerchant(merchant);
  if (!config) throw new Error(`no agent config for ${merchant}`);

  const bounds = {
    reservation: remedy.reservation,
    ceiling: remedy.ceiling,
    clause: { id: remedy.clause.id, title: remedy.clause.title },
  };

  const claim: ClaimMessage = {
    type: "CLAIM",
    claim_id: `clm_${breachKind}`,
    at: "2026-10-06T21:42:00.000Z",
    promise: {
      id: `prm_${breachKind}`,
      kind: "delivery_window",
      merchant,
      made_at: "2026-10-05T19:02:00.000Z",
      amount_at_stake: usd(68.4),
    },
    breach_kind: breachKind,
    evidence_pack: {
      items: [{ id: "evd_scan", kind: "carrier_scan", captured_at: "2026-10-06T21:12:00.000Z" }],
      coverage: 0.82,
      evaluation_interval: {
        start: "2026-10-06T20:42:00.000Z",
        end: "2026-10-06T21:42:00.000Z",
      },
    },
    policy_ref: remedy.clause.id,
    ask: openingAsk(bounds),
  };

  const agent = createMerchantAgent({
    config: behaviour ? { ...config, behaviour: { ...config.behaviour, ...behaviour } } : config,
    lookup: () => ({ stated: remedy.reservation, clause_title: remedy.clause.title }),
  });

  const session = await runSession({ ...createNegotiator({ bounds }), open: () => claim }, agent);
  return { session, remedy, claim };
}

/**
 * The storyboard's negotiations, produced rather than authored.
 *
 * These are the figures the demo video states. They now come out of the negotiator
 * arguing with a merchant agent over the merchant's own published policy, so the card
 * shows a real outcome instead of a scripted one.
 */
describe("the storyboard's negotiations", () => {
  it("settles the hero claim at twelve dollars in two rounds", async () => {
    const { session, claim } = await negotiate({
      merchant: "Northwind Parcel",
      breachKind: "phantom_delivery",
    });

    expect(claim.ask).toEqual(usd(15));
    expect(session.transcript.map((m) => m.type)).toEqual(["CLAIM", "OFFER", "COUNTER", "SETTLE"]);
    expect(session.settled).toEqual(usd(12));
    expect(session.rounds).toBe(2);
  });

  it("opens at fifteen and counters at twelve — the merchant's own two figures", async () => {
    const { session } = await negotiate({
      merchant: "Northwind Parcel",
      breachKind: "phantom_delivery",
    });
    const [, offer, counter] = session.transcript;

    expect(offer?.type === "OFFER" && offer.amount).toEqual(usd(5));
    expect(counter?.type === "COUNTER" && counter.amount).toEqual(usd(12));
    expect(counter?.type === "COUNTER" && counter.justification.policy_clause).toBe(
      "Delivery Guarantee 4.2",
    );
  });

  it("settles a missed window at eight", async () => {
    const { session } = await negotiate({
      merchant: "Northwind Parcel",
      breachKind: "missed_window",
    });

    expect(session.settled).toEqual(usd(8));
  });

  it("settles a late ride immediately when the merchant pays what it published", async () => {
    const { session } = await negotiate({ merchant: "Meridian Rides", breachKind: "late_eta" });

    expect(session.settled).toEqual(usd(3));
    expect(session.rounds).toBe(1);
  });

  it("settles a missed appointment at nine", async () => {
    const { session } = await negotiate({ merchant: "Alder Home Services", breachKind: "no_show" });

    expect(session.settled).toEqual(usd(9));
  });

  it("settles a price match at the difference, without argument", async () => {
    const { session } = await negotiate({
      merchant: "Calder & Co.",
      breachKind: "price_drop",
      shortfall: usd(15),
    });

    expect(session.settled).toEqual(usd(15));
  });

  it("is stonewalled on the late refund, and is given somewhere to go", async () => {
    const { session } = await negotiate({ merchant: "Calder & Co.", breachKind: "late_refund" });
    const decline = session.transcript.at(-1);

    expect(session.outcome).toBe("escalated");
    expect(decline?.type).toBe("DECLINE");
    expect(decline?.type === "DECLINE" && decline.escalation_route).toContain("Calder");
  });

  it("charges the same merchant two postures, because a price promise is not a refund", async () => {
    const priceMatch = await negotiate({
      merchant: "Calder & Co.",
      breachKind: "price_drop",
      shortfall: usd(15),
    });
    const refund = await negotiate({ merchant: "Calder & Co.", breachKind: "late_refund" });

    expect(priceMatch.session.outcome).toBe("settled");
    expect(refund.session.outcome).toBe("escalated");
  });
});

describe("against a merchant that punishes negotiating", () => {
  /**
   * The adversarial case the evaluation is built to contain. Countering is not free:
   * against a merchant who withdraws, the household ends with nothing where accepting
   * would have banked the opening offer.
   */
  it("ends worse off than simply taking the first offer", async () => {
    const punishing = await negotiate({
      merchant: "Northwind Parcel",
      breachKind: "phantom_delivery",
      // Withdrawing only bites when they would not have accepted the counter anyway,
      // so this merchant both refuses the published figure and punishes asking for it.
      behaviour: { withdraws_on_counter: true, accept_ratio: 0.8 },
    });

    const firstOfferMinor = punishing.session.transcript.find((m) => m.type === "OFFER");

    expect(firstOfferMinor?.type === "OFFER" && firstOfferMinor.amount).toEqual(usd(5));
    expect(punishing.session.settled?.minor ?? 0).toBeLessThan(usd(5).minor);
  });
});
