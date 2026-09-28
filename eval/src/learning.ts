import { type CounterExperience, createNegotiator, openingAsk } from "@owed/core";
import { createMerchantAgent, generateGrid, type MerchantBehaviour } from "@owed/merchant-agents";
import { builtinPolicies } from "@owed/policy-library";
import {
  type ClaimMessage,
  firstOffer,
  type RecourseMessage,
  type Respondent,
  runSession,
} from "@owed/recourse-protocol";
import { BREACH_KINDS, boundsForBreachKind, claimFor, type RemedyBoundsFor } from "./fixtures.js";

/**
 * Does learning who you are arguing with actually help?
 *
 * The cold negotiator counters whenever an offer falls short, because on the first reply
 * it cannot tell a merchant that will improve from one that will withdraw. That single
 * blind spot is the whole of its loss rate. This measures whether experience closes it.
 *
 * Four things keep the answer honest:
 *
 *  1. The pre-registered grid does not change — same 270 policies, same parameters.
 *  2. Evaluation is online and sequential. Each merchant is met cold and learned about
 *     only from encounters already had with *that* merchant, which is exactly the
 *     information a household would have.
 *  3. Episode one is reported separately and must equal the cold negotiator. If it does
 *     not, the learner is seeing something it should not.
 *  4. An oracle knowing each merchant's type bounds what is achievable, so the result is
 *     stated as a share of the available advantage rather than as a bare number.
 */

/** A household meets the same merchant about this often before the answer stops moving. */
export const DEFAULT_EPISODES = 20;

export interface StrategyTotals {
  owed_minor: number;
  realised_minor: number;
  share: number;
}

export interface LearningReport {
  episodes: number;
  grid_size: number;
  cells: number;
  accept_first_offer: StrategyTotals;
  cold: StrategyTotals;
  oracle: StrategyTotals;
  /** Episode one of the learner. Must equal `cold`. */
  first_episode: StrategyTotals;
  /** The learner once its record has settled. */
  last_episode: StrategyTotals;
  learning_curve: Array<{ episode: number; share: number }>;
  /** How much of the advantage perfect information would give, the learner captures. */
  advantage_captured: number;
  cold_loss_rate: number;
  learned_loss_rate: number;
}

function totals(owed: number, realised: number): StrategyTotals {
  return { owed_minor: owed, realised_minor: realised, share: owed === 0 ? 0 : realised / owed };
}

/** Was a counter sent, and what was on the table when that was decided? */
function decisionPoint(transcript: readonly RecourseMessage[]): {
  countered: boolean;
  standing_minor: number;
} {
  const counterIndex = transcript.findIndex((message) => message.type === "COUNTER");
  const considered = counterIndex === -1 ? transcript : transcript.slice(0, counterIndex);
  const standing = considered.filter((message) => message.type === "OFFER").at(-1);
  return {
    countered: counterIndex !== -1,
    standing_minor: standing?.type === "OFFER" ? standing.amount.minor : 0,
  };
}

interface EpisodeOutcome {
  settled_minor: number;
  first_offer_minor: number;
  countered: boolean;
}

async function runEpisode(
  resolved: RemedyBoundsFor,
  claim: ClaimMessage,
  respondent: Respondent,
  experience?: CounterExperience,
): Promise<EpisodeOutcome> {
  const negotiator = {
    ...createNegotiator({
      bounds: resolved.bounds,
      ...(experience === undefined ? {} : { experience }),
    }),
    open: () => claim,
  };
  const session = await runSession(negotiator, respondent);

  return {
    settled_minor: session.settled?.minor ?? 0,
    first_offer_minor: firstOffer(session.transcript)?.amount.minor ?? 0,
    countered: decisionPoint(session.transcript).countered,
  };
}

/** Takes whatever is first put on the table — the baseline, played as a strategy. */
async function runAcceptFirst(claim: ClaimMessage, respondent: Respondent): Promise<number> {
  const session = await runSession(
    { name: "accept-first", open: () => claim, react: () => ({ type: "ACCEPT" }) },
    respondent,
  );
  return session.settled?.minor ?? 0;
}

export async function runLearningMatrix(
  grid: readonly MerchantBehaviour[] = generateGrid(),
  episodes: number = DEFAULT_EPISODES,
): Promise<LearningReport> {
  const policies = builtinPolicies().all();
  const curve = Array.from({ length: episodes }, () => 0);

  let owedPerEpisode = 0;
  let acceptFirstTotal = 0;
  let coldTotal = 0;
  let oracleTotal = 0;
  let firstEpisodeTotal = 0;
  let lastEpisodeTotal = 0;
  let coldLosses = 0;
  let learnedLosses = 0;
  let cells = 0;

  for (const behaviour of grid) {
    for (const breachKind of BREACH_KINDS) {
      const resolved = boundsForBreachKind(policies, breachKind);
      if (resolved === undefined) continue;

      cells += 1;
      owedPerEpisode += resolved.bounds.reservation.minor;

      const claim = claimFor(resolved, openingAsk(resolved.bounds));
      const agent = (): Respondent =>
        createMerchantAgent({
          config: { merchant: resolved.merchant, behaviour },
          lookup: () => ({
            stated: resolved.bounds.reservation,
            clause_title: resolved.bounds.clause.title,
          }),
        });

      const cold = await runEpisode(resolved, claim, agent());
      const acceptFirst = await runAcceptFirst(claim, agent());

      coldTotal += cold.settled_minor;
      acceptFirstTotal += acceptFirst;
      // Perfect information picks whichever of the two available lines pays more.
      oracleTotal += Math.max(cold.settled_minor, acceptFirst);
      if (acceptFirst > cold.settled_minor) coldLosses += 1;

      // One household's history with one merchant, built up encounter by encounter.
      const experience: CounterExperience = { countered: 0, countered_realised_minor: 0 };

      for (let episode = 0; episode < episodes; episode += 1) {
        const outcome = await runEpisode(resolved, claim, agent(), experience);

        curve[episode] = (curve[episode] ?? 0) + outcome.settled_minor;
        if (episode === 0) firstEpisodeTotal += outcome.settled_minor;
        if (episode === episodes - 1) {
          lastEpisodeTotal += outcome.settled_minor;
          if (outcome.first_offer_minor > outcome.settled_minor) learnedLosses += 1;
        }

        if (outcome.countered) {
          experience.countered += 1;
          experience.countered_realised_minor += outcome.settled_minor;
        }
      }
    }
  }

  const coldShare = owedPerEpisode === 0 ? 0 : coldTotal / owedPerEpisode;
  const oracleShare = owedPerEpisode === 0 ? 0 : oracleTotal / owedPerEpisode;
  const learnedShare = owedPerEpisode === 0 ? 0 : lastEpisodeTotal / owedPerEpisode;
  const available = oracleShare - coldShare;

  return {
    episodes,
    grid_size: grid.length,
    cells,
    accept_first_offer: totals(owedPerEpisode, acceptFirstTotal),
    cold: totals(owedPerEpisode, coldTotal),
    oracle: totals(owedPerEpisode, oracleTotal),
    first_episode: totals(owedPerEpisode, firstEpisodeTotal),
    last_episode: totals(owedPerEpisode, lastEpisodeTotal),
    learning_curve: curve.map((realised, index) => ({
      episode: index + 1,
      share: owedPerEpisode === 0 ? 0 : realised / owedPerEpisode,
    })),
    advantage_captured: available <= 0 ? 0 : (learnedShare - coldShare) / available,
    cold_loss_rate: cells === 0 ? 0 : coldLosses / cells,
    learned_loss_rate: cells === 0 ? 0 : learnedLosses / cells,
  };
}
