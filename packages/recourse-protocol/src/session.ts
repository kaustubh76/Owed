import {
  type ClaimMessage,
  countRounds,
  isRespondentMessage,
  isTerminal,
  type Justification,
  type Money,
  type OfferMessage,
  type RecourseMessage,
  RecourseMessageSchema,
  type RespondentMessage,
  sameCurrency,
} from "./messages.js";

/**
 * The merchant's side. It may offer, settle or decline — never claim, never counter.
 *
 * Replies may be awaited. Any merchant worth implementing this for is across a network,
 * so a synchronous-only interface would make the package unusable for its actual
 * audience. An in-process implementation simply returns a value.
 */
export interface Respondent {
  readonly name?: string;
  respond(transcript: readonly RecourseMessage[]): RespondentMessage | Promise<RespondentMessage>;
}

export type ClaimantDecision =
  | { type: "ACCEPT" }
  | { type: "COUNTER"; amount: Money; justification: Justification }
  | { type: "ESCALATE"; reason: string };

/** The household's side. */
export interface Claimant {
  readonly name?: string;
  open(): ClaimMessage | Promise<ClaimMessage>;
  react(transcript: readonly RecourseMessage[]): ClaimantDecision | Promise<ClaimantDecision>;
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
/**
 * A reply's money has to be money for *this* claim.
 *
 * The two checks above it refuse a message type a merchant may not send and a reply
 * carrying someone else's claim id. This is the third of the same kind and it was missing,
 * which mattered more than it looks: `MoneySchema` validates the shape of an amount — three
 * uppercase letters, an integer — and says nothing about whether it is the currency anyone
 * asked for or a quantity that makes sense.
 *
 * What that cost, before this existed. The negotiator accepts on `standing.amount.minor >=
 * willSettleAt.minor`, comparing integers with no reference to the unit, so a 1200-minor
 * offer in any currency cleared a 1200-minor reservation in USD. The session recorded the
 * merchant's `amount` verbatim, `fileClaim` wrote it into a `Settled` event, and the
 * household was told "settled at twelve euros". Then it got worse: `summarize` folds
 * settlements into a `zeroMoney(currency)` accumulator and `addMoney` throws on a mismatch,
 * so from the next read onward `ledger_summary` and `promises_list` both failed with
 * `currency mismatch: USD vs EUR`. The ledger is append-only, so there was no way back —
 * one reply from one merchant took two of the six tools down permanently.
 *
 * A negative amount went the same way and read worse: accepted, recorded, and spoken as
 * "settled at minus eight dollars", because `speakMoney` renders the sign.
 *
 * `sameCurrency` is used here rather than reimplemented — it has existed in `messages.ts`
 * since the protocol was written, with `checkMerchantConformance` as its only caller, and
 * that suite has no runtime caller at all. So the one currency check in the package ran
 * only in tests.
 *
 * This is deliberately *not* a narrowing of `MoneySchema`. The protocol is published and
 * lifted out of this repository as it stands; a receiver refusing what the wire format
 * permits is Owed's policy, and policy belongs at the session boundary where the claim it
 * is being compared against is in scope.
 */
function assertAnswersTheClaim(reply: RespondentMessage, claim: ClaimMessage): void {
  if (!("amount" in reply)) return;

  if (!sameCurrency(reply.amount, claim.ask)) {
    throw new ProtocolViolation(
      `reply is in ${reply.amount.currency} and the claim is in ${claim.ask.currency}`,
    );
  }
  if (reply.amount.minor < 0) {
    throw new ProtocolViolation(`reply names a negative amount in ${reply.amount.currency}`);
  }
}

export async function runSession(
  claimant: Claimant,
  respondent: Respondent,
  options: SessionOptions = {},
): Promise<SessionResult> {
  const maxRounds = options.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const clock = options.clock ?? defaultClock;

  const claim = expectValid(await claimant.open(), "claimant") as ClaimMessage;
  if (claim.type !== "CLAIM") throw new ProtocolViolation("a session must open with a CLAIM");

  const transcript: RecourseMessage[] = [claim];
  let step = 0;

  const finish = (
    outcome: SessionOutcome,
    reason: string,
    settled?: Money,
    rounds = countRounds(transcript),
  ): SessionResult => ({
    transcript,
    outcome,
    ...(settled === undefined ? {} : { settled }),
    rounds,
    reason,
  });

  while (countRounds(transcript) < maxRounds) {
    step += 1;
    const reply = expectValid(
      await respondent.respond(transcript),
      respondent.name ?? "respondent",
    );

    if (!isRespondentMessage(reply)) {
      throw new ProtocolViolation(`a merchant may not send ${reply.type}`);
    }
    if (reply.claim_id !== claim.claim_id) {
      throw new ProtocolViolation("reply carries a different claim id");
    }
    assertAnswersTheClaim(reply, claim);
    transcript.push(reply);

    if (reply.type === "SETTLE") return finish("settled", "the merchant settled", reply.amount);
    if (reply.type === "DECLINE") {
      return finish("escalated", `declined: ${reply.reason}`);
    }

    /**
     * The two branches above are the terminal message types, and this is what keeps them
     * honest.
     *
     * `TERMINAL_MESSAGE_TYPES` declares which messages end an exchange and `isTerminal`
     * reads it; the loop hardcodes the same two and nothing connected the two facts, so a
     * third terminal type added to the protocol would have left this loop arguing with a
     * merchant who had already finished — silently, because every other check here passes.
     *
     * Reaching this line with a terminal reply is a bug in the protocol's own
     * exhaustiveness rather than bad input, which is why it throws rather than finishing.
     */
    if (isTerminal(reply)) {
      throw new ProtocolViolation(
        `${reply.type} ends an exchange but this session did not stop for it`,
      );
    }

    const decision = await claimant.react(transcript);

    if (decision.type === "ACCEPT") {
      // Counted before the settlement is recorded: accepting an offer is not another
      // round of argument, it is the end of the one that just happened.
      const rounds = countRounds(transcript);
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
      return finish("settled", "the claimant accepted the offer", reply.amount, rounds);
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
