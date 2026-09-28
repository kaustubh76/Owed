import {
  type ClaimMessage,
  type Money,
  RESPONDENT_MESSAGE_TYPES,
  RecourseMessageSchema,
  sameCurrency,
} from "./messages.js";
import { type Claimant, type Respondent, runSession } from "./session.js";

export interface MerchantCheck {
  id: string;
  description: string;
  /** Advisory checks report but never fail the run. */
  advisory?: boolean;
  pass: boolean;
  detail: string;
}

export interface MerchantConformanceReport {
  merchant: string;
  results: MerchantCheck[];
  passed: boolean;
}

const usd = (major: number): Money => ({ minor: Math.round(major * 100), currency: "USD" });

/** A representative claim, exported because implementations want it for their own tests. */
export function sampleClaim(overrides: Partial<ClaimMessage> = {}): ClaimMessage {
  return {
    type: "CLAIM",
    claim_id: "clm_conformance",
    at: "2026-01-01T00:00:00.000Z",
    promise: {
      id: "prm_conformance",
      kind: "delivery_window",
      merchant: "Conformance Merchant",
      made_at: "2026-01-01T00:00:00.000Z",
      window: { start: "2026-01-02T12:00:00.000Z", end: "2026-01-02T16:00:00.000Z" },
      amount_at_stake: usd(60),
    },
    breach_kind: "phantom_delivery",
    evidence_pack: {
      items: [
        { id: "evd_1", kind: "carrier_scan", captured_at: "2026-01-02T14:12:00.000Z" },
        { id: "evd_2", kind: "doorbell_snapshot", captured_at: "2026-01-02T14:13:00.000Z" },
      ],
      coverage: 0.82,
      evaluation_interval: {
        start: "2026-01-02T13:42:00.000Z",
        end: "2026-01-02T14:42:00.000Z",
      },
    },
    policy_ref: "conformance/guarantee#1",
    ask: usd(15),
    ...overrides,
  };
}

/** Accepts whatever it is offered — used to drive a session to a conclusion. */
function acceptingClaimant(claim: ClaimMessage): Claimant {
  return { name: "conformance-claimant", open: () => claim, react: () => ({ type: "ACCEPT" }) };
}

/**
 * Check a merchant implementation against recourse/v1.
 *
 * Anyone implementing the protocol can run this against their own agent. It tests the
 * obligations the specification actually imposes, not our negotiator's preferences:
 * a merchant is free to decline every claim and still be fully conformant.
 */
export function checkMerchantConformance(
  respondent: Respondent,
  claim: ClaimMessage = sampleClaim(),
): MerchantConformanceReport {
  const results: MerchantCheck[] = [];
  const record = (check: MerchantCheck) => results.push(check);

  let reply: unknown;
  try {
    reply = respondent.respond([claim]);
  } catch (error) {
    record({
      id: "replies-to-claim",
      description: "Answers a CLAIM instead of throwing.",
      pass: false,
      detail: error instanceof Error ? error.message : String(error),
    });
    return { merchant: respondent.name ?? "respondent", results, passed: false };
  }

  const parsed = RecourseMessageSchema.safeParse(reply);
  record({
    id: "valid-messages",
    description: "Every reply validates against the recourse/v1 schema.",
    pass: parsed.success,
    detail: parsed.success ? `sent ${parsed.data.type}` : "reply did not validate",
  });

  if (!parsed.success) {
    return { merchant: respondent.name ?? "respondent", results, passed: false };
  }

  const message = parsed.data;

  record({
    id: "no-claimant-messages",
    description: "Never sends a message only a claimant may send.",
    pass: RESPONDENT_MESSAGE_TYPES.includes(message.type),
    detail: `sent ${message.type}`,
  });

  record({
    id: "echoes-claim-id",
    description: "Every message carries the claim id it is answering.",
    pass: message.claim_id === claim.claim_id,
    detail: `claim_id ${message.claim_id}`,
  });

  const amount = "amount" in message ? message.amount : undefined;
  record({
    id: "matching-currency",
    description: "Any amount is in the currency of the claim.",
    pass: amount === undefined || sameCurrency(amount, claim.ask),
    detail:
      amount === undefined ? "no amount to check" : `${amount.currency} vs ${claim.ask.currency}`,
  });

  record({
    id: "decline-carries-escalation-route",
    description: "A DECLINE leaves the household somewhere to go.",
    pass: message.type !== "DECLINE" || message.escalation_route.trim().length > 0,
    detail: message.type === "DECLINE" ? message.escalation_route : "did not decline",
  });

  let conclusion = "";
  let reachedConclusion = false;
  try {
    const session = runSession(acceptingClaimant(claim), respondent);
    reachedConclusion = true;
    conclusion = `${session.outcome} after ${session.rounds} round(s)`;
  } catch (error) {
    conclusion = error instanceof Error ? error.message : String(error);
  }
  record({
    id: "reaches-a-conclusion",
    description:
      "A full session ends in a settlement or an escalation, without violating the protocol.",
    pass: reachedConclusion,
    detail: conclusion,
  });

  const repeat = RecourseMessageSchema.safeParse(respondent.respond([claim]));
  record({
    id: "deterministic-first-reply",
    description: "The same transcript produces the same kind of reply.",
    advisory: true,
    pass: repeat.success && repeat.data.type === message.type,
    detail: repeat.success ? `repeated ${repeat.data.type}` : "repeat did not validate",
  });

  return {
    merchant: respondent.name ?? "respondent",
    results,
    passed: results.filter((check) => check.advisory !== true).every((check) => check.pass),
  };
}
