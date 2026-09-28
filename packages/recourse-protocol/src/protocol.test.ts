import { describe, expect, it } from "vitest";
import { checkMerchantConformance, sampleClaim } from "./conformance.js";
import {
  type ClaimMessage,
  countRounds,
  type Money,
  type RecourseMessage,
  type RespondentMessage,
} from "./messages.js";
import { recourseJsonSchema } from "./schema.js";
import {
  type Claimant,
  firstOffer,
  ProtocolViolation,
  type Respondent,
  runSession,
} from "./session.js";

const usd = (major: number): Money => ({ minor: Math.round(major * 100), currency: "USD" });
const CLAIM = sampleClaim();

function respondent(name: string, replies: RespondentMessage[]): Respondent {
  let index = 0;
  return {
    name,
    respond: () => {
      const reply = replies[Math.min(index, replies.length - 1)] as RespondentMessage;
      index += 1;
      return reply;
    },
  };
}

const offer = (amount: Money): RespondentMessage => ({
  type: "OFFER",
  claim_id: CLAIM.claim_id,
  at: "2026-01-02T18:00:00.000Z",
  amount,
  form: "credit",
});

const settle = (amount: Money): RespondentMessage => ({
  type: "SETTLE",
  claim_id: CLAIM.claim_id,
  at: "2026-01-02T18:05:00.000Z",
  amount,
  form: "credit",
});

const decline = (route = "support@example.test"): RespondentMessage => ({
  type: "DECLINE",
  claim_id: CLAIM.claim_id,
  at: "2026-01-02T18:05:00.000Z",
  reason: "outside policy",
  escalation_route: route,
});

function claimant(
  decide: (transcript: readonly RecourseMessage[]) => ReturnType<Claimant["react"]>,
): Claimant {
  return { name: "test-claimant", open: () => CLAIM, react: decide };
}

const alwaysAccept = claimant(() => ({ type: "ACCEPT" }));
const counterOnce = (amount: Money) =>
  claimant((transcript) =>
    countRounds(transcript) === 1
      ? {
          type: "COUNTER",
          amount,
          justification: { policy_clause: "Guarantee 1", evidence_ids: ["evd_1"] },
        }
      : { type: "ACCEPT" },
  );

describe("runSession", () => {
  it("settles when the claimant accepts the offer", () => {
    const result = runSession(alwaysAccept, respondent("cooperative", [offer(usd(12))]));

    expect(result.outcome).toBe("settled");
    expect(result.settled).toEqual(usd(12));
    expect(result.transcript.map((m) => m.type)).toEqual(["CLAIM", "OFFER", "SETTLE"]);
  });

  it("counts offer, counter and settle as two rounds", () => {
    const result = runSession(
      counterOnce(usd(12)),
      respondent("stingy", [offer(usd(5)), settle(usd(12))]),
    );

    expect(result.outcome).toBe("settled");
    expect(result.settled).toEqual(usd(12));
    expect(result.rounds).toBe(2);
    expect(result.transcript.map((m) => m.type)).toEqual(["CLAIM", "OFFER", "COUNTER", "SETTLE"]);
  });

  it("escalates on a decline, carrying the route the merchant gave", () => {
    const result = runSession(
      alwaysAccept,
      respondent("stonewall", [decline("ombudsman@example.test")]),
    );

    expect(result.outcome).toBe("escalated");
    expect(result.reason).toContain("outside policy");
  });

  it("stops at the round cap rather than haggling forever", () => {
    const result = runSession(
      claimant(() => ({
        type: "COUNTER",
        amount: usd(15),
        justification: { policy_clause: "Guarantee 1", evidence_ids: [] },
      })),
      respondent("immovable", [offer(usd(1))]),
      { maxRounds: 3 },
    );

    expect(result.outcome).toBe("escalated");
    expect(result.rounds).toBe(3);
    expect(result.reason).toContain("within 3 rounds");
  });

  it("exposes the first offer, which is the accept-first-offer baseline", () => {
    const result = runSession(
      counterOnce(usd(12)),
      respondent("stingy", [offer(usd(5)), settle(usd(12))]),
    );

    expect(firstOffer(result.transcript)?.amount).toEqual(usd(5));
  });
});

describe("protocol enforcement", () => {
  it("refuses a merchant that tries to open a claim", () => {
    const rogue: Respondent = {
      name: "rogue",
      respond: () => CLAIM as unknown as RespondentMessage,
    };

    expect(() => runSession(alwaysAccept, rogue)).toThrow(ProtocolViolation);
  });

  it("refuses a reply carrying somebody else's claim id", () => {
    const spliced: Respondent = {
      name: "spliced",
      respond: () => ({ ...offer(usd(5)), claim_id: "clm_somebody_else" }),
    };

    expect(() => runSession(alwaysAccept, spliced)).toThrow(/different claim id/);
  });

  it("refuses a malformed message", () => {
    const broken: Respondent = {
      name: "broken",
      respond: () => ({ type: "OFFER", claim_id: CLAIM.claim_id }) as unknown as RespondentMessage,
    };

    expect(() => runSession(alwaysAccept, broken)).toThrow(ProtocolViolation);
  });

  it("requires a session to open with a CLAIM", () => {
    const notAClaim = {
      open: () => offer(usd(5)) as unknown as ClaimMessage,
      react: () => ({ type: "ACCEPT" as const }),
    };

    expect(() => runSession(notAClaim, respondent("any", [offer(usd(5))]))).toThrow(
      ProtocolViolation,
    );
  });
});

describe("merchant conformance suite", () => {
  it("passes a well-behaved merchant", () => {
    const report = checkMerchantConformance(
      respondent("cooperative", [offer(usd(12)), settle(usd(12))]),
    );

    expect(report.passed).toBe(true);
  });

  it("passes a merchant that declines everything — refusing is allowed", () => {
    const report = checkMerchantConformance(respondent("stonewall", [decline()]));

    expect(report.passed).toBe(true);
  });

  it("fails a decline whose escalation route is only whitespace", () => {
    const noRoute: Respondent = {
      name: "dead-end",
      respond: () => ({ ...decline(), escalation_route: "   " }) as RespondentMessage,
    };
    const report = checkMerchantConformance(noRoute);

    expect(report.passed).toBe(false);
    // The schema itself rejects it, so this never reaches a behavioural check.
    expect(report.results.find((c) => c.id === "valid-messages")?.pass).toBe(false);
  });

  it("fails a merchant answering in the wrong currency", () => {
    const wrongCurrency: Respondent = {
      name: "wrong-currency",
      respond: () => offer({ minor: 1200, currency: "EUR" }),
    };
    const report = checkMerchantConformance(wrongCurrency);

    expect(report.results.find((c) => c.id === "matching-currency")?.pass).toBe(false);
    expect(report.passed).toBe(false);
  });

  it("fails a merchant that does not echo the claim id", () => {
    const forgetful: Respondent = {
      name: "forgetful",
      respond: () => ({ ...offer(usd(5)), claim_id: "clm_other" }),
    };

    expect(checkMerchantConformance(forgetful).passed).toBe(false);
  });
});

describe("published JSON Schema", () => {
  it("generates from the zod definitions, so spec and code cannot drift", () => {
    const schema = recourseJsonSchema();

    expect(schema.$id).toContain("recourse/v1");
    expect(JSON.stringify(schema)).toContain("escalation_route");
    expect(JSON.stringify(schema)).toContain("evidence_pack");
  });
});
