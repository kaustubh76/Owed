import {
  type ClaimMessage,
  countRounds,
  isRespondentMessage,
  type Justification,
  type Money,
  type OfferMessage,
  type RecourseMessage,
  RecourseMessageSchema,
  type RespondentMessage,
} from "./messages.js";

/** The merchant's side. It may offer, settle or decline — never claim, never counter. */
export interface Respondent {
  readonly name?: string;
  respond(transcript: readonly RecourseMessage[]): RespondentMessage;
}

export type ClaimantDecision =
  | { type: "ACCEPT" }
  | { type: "COUNTER"; amount: Money; justification: Justification }
  | { type: "ESCALATE"; reason: string };

/** The household's side. */
export interface Claimant {
  readonly name?: string;
  open(): ClaimMessage;
  react(transcript: readonly RecourseMessage[]): ClaimantDecision;
}

/** Three exchanges is the documented cap; a household is not made to haggle. */
export const DEFAULT_MAX_ROUNDS = 3;

export interface SessionOptions {
  maxRounds?: number;
  /** Injected so a transcript is byte-identical on every run. */
  clock?: (step: number) => string;
}

export type SessionOutcome = "settled" | "escalated";

export interface SessionResult {
  transcript: RecourseMessage[];
  outcome: SessionOutcome;
  settled?: Money;
  /** Merchant replies, which is what "two rounds" means on the card. */
  rounds: number;
  reason: string;
}

const BASE_INSTANT_MS = Date.parse("2026-01-01T00:00:00Z");
const defaultClock = (step: number) => new Date(BASE_INSTANT_MS + step * 60_000).toISOString();

export class ProtocolViolation extends Error {}

function expectValid(message: unknown, from: string): RecourseMessage {
  const parsed = RecourseMessageSchema.safeParse(message);
  if (!parsed.success) {
    throw new ProtocolViolation(`${from} sent a message that is not valid recourse/v1`);
  }
  return parsed.data;
}

/**
 * Run one negotiation to a conclusion.
 *
 * The loop is the enforcement point: every message is validated, the claim id must
 * hold across the transcript, and a merchant that says something only a claimant may
 * say is rejected rather than tolerated. That is what lets the same code drive both
 * the in-process evaluation and the real agents over HTTP.
 */
export function runSession(
  claimant: Claimant,
  respondent: Respondent,
  options: SessionOptions = {},
): SessionResult {
  const maxRounds = options.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const clock = options.clock ?? defaultClock;

  const claim = expectValid(claimant.open(), "claimant") as ClaimMessage;
  if (claim.type !== "CLAIM") throw new ProtocolViolation("a session must open with a CLAIM");

  const transcript: RecourseMessage[] = [claim];
  let step = 0;

  const finish = (outcome: SessionOutcome, reason: string, settled?: Money): SessionResult => ({
    transcript,
    outcome,
    ...(settled === undefined ? {} : { settled }),
    rounds: countRounds(transcript),
    reason,
  });

  while (countRounds(transcript) < maxRounds) {
    step += 1;
    const reply = expectValid(respondent.respond(transcript), respondent.name ?? "respondent");

    if (!isRespondentMessage(reply)) {
      throw new ProtocolViolation(`a merchant may not send ${reply.type}`);
    }
    if (reply.claim_id !== claim.claim_id) {
      throw new ProtocolViolation("reply carries a different claim id");
    }
    transcript.push(reply);

    if (reply.type === "SETTLE") return finish("settled", "the merchant settled", reply.amount);
    if (reply.type === "DECLINE") {
      return finish("escalated", `declined: ${reply.reason}`);
    }

    const decision = claimant.react(transcript);

    if (decision.type === "ACCEPT") {
      // The offer stands, so the merchant is taken at its word: the settlement is
      // recorded as theirs, at the amount they named.
      step += 1;
      transcript.push({
        type: "SETTLE",
        claim_id: claim.claim_id,
        at: clock(step),
        amount: reply.amount,
        form: reply.form,
      });
      return finish("settled", "the claimant accepted the offer", reply.amount);
    }

    if (decision.type === "ESCALATE") {
      return finish("escalated", decision.reason);
    }

    step += 1;
    transcript.push({
      type: "COUNTER",
      claim_id: claim.claim_id,
      at: clock(step),
      amount: decision.amount,
      justification: decision.justification,
    });
  }

  return finish("escalated", `no settlement within ${maxRounds} rounds`);
}

/** The merchant's opening number — the "accept first offer" baseline. */
export function firstOffer(transcript: readonly RecourseMessage[]): OfferMessage | undefined {
  return transcript.find((message): message is OfferMessage => message.type === "OFFER");
}
