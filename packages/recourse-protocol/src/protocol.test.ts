import { describe, expect, it } from "vitest";
import { checkMerchantConformance, sampleClaim } from "./conformance.js";
import {
  type ClaimMessage,
  countRounds,
  type DeclineMessage,
  DeclineMessageSchema,
  type EvidencePack,
  EvidencePackSchema,
  isTerminal,
  type Money,
  type PromiseRef,
  PromiseRefSchema,
  type RecourseMessage,
  type RespondentMessage,
  type SettleMessage,
  SettleMessageSchema,
  TERMINAL_MESSAGE_TYPES,
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

describe("the protocol's terminal messages and the loop that honours them", () => {
  /**
   * `TERMINAL_MESSAGE_TYPES` declares which replies end an exchange. `runSession`
   * hardcoded the same two in separate branches, and nothing tied the two facts together
   * — so a third terminal type added to the protocol would have left the loop arguing
   * with a merchant who had already finished, and every other check in the session would
   * still have passed.
   *
   * The session now guards that with `isTerminal`. This is the other half: proof that
   * every declared terminal type is actually one the loop stops for.
   */
  it("stops for every message type it calls terminal", async () => {
    const endings: Record<string, () => RespondentMessage> = {
      SETTLE: () => settle(usd(12)),
      DECLINE: () => decline(),
    };

    // The assertion that makes this test keep working: adding a terminal type to the
    // protocol without covering it here fails immediately, rather than quietly leaving
    // the new type untested.
    expect(Object.keys(endings).sort()).toStrictEqual([...TERMINAL_MESSAGE_TYPES].sort());

    for (const type of TERMINAL_MESSAGE_TYPES) {
      const build = endings[type];
      if (build === undefined) throw new Error(`no ending built for ${type}`);

      const result = await runSession(alwaysAccept, respondent("ends it", [build()]));
      const last = result.transcript.at(-1);

      expect(last?.type, `${type} should be the last message`).toBe(type);
      expect(isTerminal(last as RecourseMessage), `${type} should be terminal`).toBe(true);
      expect(["settled", "escalated"]).toContain(result.outcome);
    }
  });
});

describe("runSession", () => {
  it("settles when the claimant accepts the offer", async () => {
    const result = await runSession(alwaysAccept, respondent("cooperative", [offer(usd(12))]));

    expect(result.outcome).toBe("settled");
    expect(result.settled).toEqual(usd(12));
    expect(result.transcript.map((m) => m.type)).toEqual(["CLAIM", "OFFER", "SETTLE"]);
  });

  it("counts offer, counter and settle as two rounds", async () => {
    const result = await runSession(
      counterOnce(usd(12)),
      respondent("stingy", [offer(usd(5)), settle(usd(12))]),
    );

    expect(result.outcome).toBe("settled");
    expect(result.settled).toEqual(usd(12));
    expect(result.rounds).toBe(2);
    expect(result.transcript.map((m) => m.type)).toEqual(["CLAIM", "OFFER", "COUNTER", "SETTLE"]);
  });

  it("escalates on a decline, carrying the route the merchant gave", async () => {
    const result = await runSession(
      alwaysAccept,
      respondent("stonewall", [decline("ombudsman@example.test")]),
    );

    expect(result.outcome).toBe("escalated");
    expect(result.reason).toContain("outside policy");
  });

  it("stops at the round cap rather than haggling forever", async () => {
    const result = await runSession(
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

  it("exposes the first offer, which is the accept-first-offer baseline", async () => {
    const result = await runSession(
      counterOnce(usd(12)),
      respondent("stingy", [offer(usd(5)), settle(usd(12))]),
    );

    expect(firstOffer(result.transcript)?.amount).toEqual(usd(5));
  });
});

describe("protocol enforcement", () => {
  it("refuses a merchant that tries to open a claim", async () => {
    const rogue: Respondent = {
      name: "rogue",
      respond: () => CLAIM as unknown as RespondentMessage,
    };

    await expect(runSession(alwaysAccept, rogue)).rejects.toThrow(ProtocolViolation);
  });

  it("refuses a reply carrying somebody else's claim id", async () => {
    const spliced: Respondent = {
      name: "spliced",
      respond: () => ({ ...offer(usd(5)), claim_id: "clm_somebody_else" }),
    };

    await expect(runSession(alwaysAccept, spliced)).rejects.toThrow(/different claim id/);
  });

  it("refuses a malformed message", async () => {
    const broken: Respondent = {
      name: "broken",
      respond: () => ({ type: "OFFER", claim_id: CLAIM.claim_id }) as unknown as RespondentMessage,
    };

    await expect(runSession(alwaysAccept, broken)).rejects.toThrow(ProtocolViolation);
  });

  /**
   * The settlement that is really a refusal.
   *
   * `DECLINE` is required to carry a reason *and* an escalation route, because a merchant may
   * refuse but may not leave a household with nowhere to go. A `SETTLE` for nothing closed the
   * claim as a settlement, was spoken as a recovery, and carried neither.
   */
  it("refuses a settlement of nothing, which is a decline wearing a settlement's clothes", async () => {
    await expect(runSession(alwaysAccept, respondent("nothing", [settle(usd(0))]))).rejects.toThrow(
      /DECLINE/,
    );
  });

  /** A zero *offer* is ordinary haggling, and the evaluation grid runs `anchor_ratio: 0`. */
  it("allows an offer of nothing, which is only a hard opening position", async () => {
    const result = await runSession(
      alwaysAccept,
      respondent("lowball", [offer(usd(0)), settle(usd(5))]),
    );

    expect(result.outcome).toBe("settled");
  });

  /**
   * Deliberately allowed, and tested so nobody "fixes" it.
   *
   * A rule refusing any reply above `claim.ask` was written and the pre-registered evaluation
   * grid refused it — `reply names 1600 USD against an ask of 1500`. `accept_ratio` runs above
   * 1 on purpose: a merchant whose published terms are more generous than the claimant's
   * reading of them pays more than it was asked for, which is a merchant behaving well. The
   * claimant asks; it does not cap.
   */
  it("accepts a reply more generous than the ask", async () => {
    const result = await runSession(alwaysAccept, respondent("generous", [settle(usd(20))]));

    expect(CLAIM.ask).toEqual(usd(15));
    expect(result.settled).toEqual(usd(20));
  });

  /**
   * And the published suite reports it, without a check of its own.
   *
   * A dedicated conformance check could never be exercised: `runSession` refuses the transcript
   * before the suite could inspect a zero settlement, so `reaches-a-conclusion` is where a
   * merchant author sees it — carrying the violation's own message, which is more use than a
   * boolean.
   */
  it("tells a merchant author why, through the conformance suite", async () => {
    const report = await checkMerchantConformance(respondent("nothing", [settle(usd(0))]));

    expect(report.passed).toBe(false);
    const failed = report.results.filter((check) => !check.pass);
    expect(failed.map((check) => check.id)).toStrictEqual(["reaches-a-conclusion"]);
    expect(failed[0]?.detail).toMatch(/DECLINE/);
  });

  it("requires a session to open with a CLAIM", async () => {
    const notAClaim = {
      open: () => offer(usd(5)) as unknown as ClaimMessage,
      react: () => ({ type: "ACCEPT" as const }),
    };

    await expect(runSession(notAClaim, respondent("any", [offer(usd(5))]))).rejects.toThrow(
      ProtocolViolation,
    );
  });
});

describe("merchant conformance suite", () => {
  it("passes a well-behaved merchant", async () => {
    const report = await checkMerchantConformance(
      respondent("cooperative", [offer(usd(12)), settle(usd(12))]),
    );

    expect(report.passed).toBe(true);
  });

  it("passes a merchant that declines everything — refusing is allowed", async () => {
    const report = await checkMerchantConformance(respondent("stonewall", [decline()]));

    expect(report.passed).toBe(true);
  });

  it("fails a decline whose escalation route is only whitespace", async () => {
    const noRoute: Respondent = {
      name: "dead-end",
      respond: () => ({ ...decline(), escalation_route: "   " }) as RespondentMessage,
    };
    const report = await checkMerchantConformance(noRoute);

    expect(report.passed).toBe(false);
    // The schema itself rejects it, so this never reaches a behavioural check.
    expect(report.results.find((c) => c.id === "valid-messages")?.pass).toBe(false);
  });

  it("fails a merchant answering in the wrong currency", async () => {
    const wrongCurrency: Respondent = {
      name: "wrong-currency",
      respond: () => offer({ minor: 1200, currency: "EUR" }),
    };
    const report = await checkMerchantConformance(wrongCurrency);

    expect(report.results.find((c) => c.id === "matching-currency")?.pass).toBe(false);
    expect(report.passed).toBe(false);
  });

  it("fails a merchant that does not echo the claim id", async () => {
    const forgetful: Respondent = {
      name: "forgetful",
      respond: () => ({ ...offer(usd(5)), claim_id: "clm_other" }),
    };

    expect((await checkMerchantConformance(forgetful)).passed).toBe(false);
  });
});

/**
 * The types this package publishes, used the way a consumer would use them.
 *
 * `@owed/recourse-protocol` is published, so its exported types *are* the contract — and
 * four of them were referenced nowhere, not even by a test: `PromiseRef`, `EvidencePack`,
 * `SettleMessage` and `DeclineMessage`. A type alias cannot be asserted at runtime, but it
 * can be used, and `tsc -b` checks the use. These annotations fail to compile if a field
 * is renamed, loses its optionality, or changes shape — which is the thing worth catching
 * in a package somebody else builds against.
 *
 * The literals are also parsed, so the schema and the type cannot drift apart silently in
 * the one direction a type annotation alone would miss.
 */
describe("the types this package publishes", () => {
  it("describes a promise and its evidence the way the schemas parse them", () => {
    const promise: PromiseRef = {
      id: "prm_001",
      kind: "delivery_window",
      merchant: "Northwind Parcel",
      made_at: "2026-10-11T04:15:00-07:00",
      source_ref: "msg_prm_001",
      window: {
        start: "2026-10-11T20:00:00.000Z",
        end: "2026-10-12T00:00:00.000Z",
      },
      amount_at_stake: { minor: 5400, currency: "USD" },
    };
    const pack: EvidencePack = {
      items: [{ id: "evd_scan_012", kind: "carrier_scan", captured_at: "2026-10-12T01:20:00Z" }],
      coverage: 1,
      evaluation_interval: {
        start: "2026-10-11T20:00:00.000Z",
        end: "2026-10-12T00:00:00.000Z",
      },
    };

    expect(PromiseRefSchema.parse(promise)).toStrictEqual(promise);
    expect(EvidencePackSchema.parse(pack)).toStrictEqual(pack);
  });

  it("describes the two ways an exchange ends", () => {
    const settle: SettleMessage = {
      claim_id: "clm_001",
      at: "2026-10-12T02:30:00.000Z",
      type: "SETTLE",
      amount: { minor: 800, currency: "USD" },
      form: "credit",
    };
    const decline: DeclineMessage = {
      claim_id: "clm_004",
      at: "2026-10-08T19:16:00.000Z",
      type: "DECLINE",
      reason: "We do not consider this claim to fall within the policy as written.",
      escalation_route: "Calder & Co. customer relations",
    };

    expect(SettleMessageSchema.parse(settle)).toStrictEqual(settle);
    expect(DeclineMessageSchema.parse(decline)).toStrictEqual(decline);

    // And the pair a respondent must not be able to continue past.
    expect(isTerminal(settle)).toBe(true);
    expect(isTerminal(decline)).toBe(true);
  });
});

describe("published JSON Schema", () => {
  it("generates from the zod definitions, so spec and code cannot drift", async () => {
    const schema = recourseJsonSchema();

    expect(schema.$id).toContain("recourse/v1");
    expect(JSON.stringify(schema)).toContain("escalation_route");
    expect(JSON.stringify(schema)).toContain("evidence_pack");
  });
});
