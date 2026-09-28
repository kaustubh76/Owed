import {
  countRounds,
  type Justification,
  type Money,
  type OfferMessage,
  type RecourseMessage,
} from "@owed/recourse-protocol";

/**
 * What a merchant's own policy entitles the household to.
 *
 * Structurally satisfied by the policy library's `ResolvedRemedy`, but declared here so
 * `@owed/core` keeps no dependency on a package that reads the filesystem.
 */
export interface RemedyBounds {
  /** The figure the merchant published. */
  reservation: Money;
  /** The most their own wording can be read to allow. */
  ceiling: Money;
  clause: { id: string; title: string };
}

/**
 * What this household has learned about arguing with this merchant about this kind of
 * broken promise.
 *
 * Declared structurally so the negotiator does not depend on the ledger layer; the
 * `MerchantPrior` projection satisfies it.
 */
export interface CounterExperience {
  countered: number;
  countered_realised_minor: number;
}

export interface NegotiatorOptions {
  bounds: RemedyBounds;
  maxRounds?: number;
  evidenceIds?: readonly string[];
  coverageStatement?: string;
  /** Absent means a cold start: nothing known about this merchant yet. */
  experience?: CounterExperience;
  /** Tries before experience is trusted over optimism. */
  minObservations?: number;
}

export type NegotiatorAction =
  | { type: "ACCEPT" }
  | { type: "COUNTER"; amount: Money; justification: Justification }
  | { type: "ESCALATE"; reason: string };

export const DEFAULT_MAX_ROUNDS = 3;

/**
 * How many times countering must have been tried before its record is trusted.
 *
 * Below this the negotiator counters regardless, because you cannot learn that a
 * merchant punishes negotiation without negotiating with them. Optimism under
 * uncertainty, and the cost of it is bounded by how few tries it takes.
 */
export const MIN_OBSERVATIONS = 3;

/**
 * Has arguing with this merchant, about this, actually paid?
 *
 * Compares what countering has realised on average against what is being given up to
 * try it. Not a model — a mean and a comparison, with every input to it sitting in the
 * ledger where it can be read.
 */
export function counteringHasPaid(
  experience: CounterExperience | undefined,
  standingMinor: number,
  minObservations: number = MIN_OBSERVATIONS,
): boolean | undefined {
  if (experience === undefined || experience.countered < minObservations) return undefined;
  return experience.countered_realised_minor / experience.countered > standingMinor;
}

/** The opening ask: the most the merchant's own wording allows, and never more. */
export function openingAsk(bounds: RemedyBounds): Money {
  return bounds.ceiling;
}

function offers(transcript: readonly RecourseMessage[]): OfferMessage[] {
  return transcript.filter((message): message is OfferMessage => message.type === "OFFER");
}

/**
 * The offer currently on the table — the last one, not the best one ever seen.
 *
 * An offer a merchant has since reduced or withdrawn is not something the household
 * can accept, and accepting is what settles at the amount named. Reading the best
 * historical figure here would let the negotiator agree to a number nobody is still
 * offering.
 */
export function standingOffer(transcript: readonly RecourseMessage[]): OfferMessage | undefined {
  return offers(transcript).at(-1);
}

/**
 * Decide what to say next.
 *
 * The strategy is the product's stance made executable, and it has exactly two
 * positions. Accept anything at or above what the merchant published. Otherwise counter
 * at that published figure, citing the clause — never a number of our own invention,
 * and never above what their wording allows.
 *
 * At the round cap it takes the best offer on the table rather than walking away on
 * principle: a household is better off with five dollars than with a point well made.
 * Escalation is for when nothing was offered at all.
 */
export function nextAction(
  transcript: readonly RecourseMessage[],
  options: NegotiatorOptions,
): NegotiatorAction {
  const { bounds } = options;
  const maxRounds = options.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const standing = standingOffer(transcript);

  if (standing !== undefined && standing.amount.minor >= bounds.reservation.minor) {
    return { type: "ACCEPT" };
  }

  const takeWhatIsStanding = (reason: string): NegotiatorAction =>
    standing === undefined || standing.amount.minor <= 0
      ? { type: "ESCALATE", reason }
      : { type: "ACCEPT" };

  if (countRounds(transcript) >= maxRounds) {
    // Take what is actually on the table. Nothing on the table is an escalation, not
    // an acceptance of nothing.
    return takeWhatIsStanding("the merchant left nothing on the table within the round cap");
  }

  // Experience, once there is enough of it. This is the whole of the difference between
  // the cold negotiator and the learning one: against a merchant whose record shows that
  // arguing costs more than it wins, stop arguing.
  if (
    counteringHasPaid(
      options.experience,
      standing?.amount.minor ?? 0,
      options.minObservations ?? MIN_OBSERVATIONS,
    ) === false
  ) {
    return takeWhatIsStanding("this merchant has withdrawn more often than it has improved");
  }

  return {
    type: "COUNTER",
    amount: bounds.reservation,
    justification: {
      policy_clause: bounds.clause.title,
      evidence_ids: [...(options.evidenceIds ?? [])],
      ...(options.coverageStatement === undefined
        ? {}
        : { coverage_statement: options.coverageStatement }),
    },
  };
}

/**
 * The household's side of a session, as the protocol expects it.
 *
 * `open` is supplied rather than built here because composing a CLAIM needs the promise
 * and the evidence pack, which are the caller's to know.
 */
export function createNegotiator(options: NegotiatorOptions) {
  return {
    name: "owed-negotiator",
    react: (transcript: readonly RecourseMessage[]) => nextAction(transcript, options),
  };
}
