import type { BreachKind, Money } from "@owed/policy-library";
import {
  type ClaimMessage,
  type CounterMessage,
  countRounds,
  type OfferMessage,
  type RecourseMessage,
  type Respondent,
  type RespondentMessage,
  type Money as WireMoney,
} from "@owed/recourse-protocol";
import { behaviourFor, type MerchantConfig } from "./behaviour.js";

/** What the merchant's own policy says they owe for this breach. */
export interface StatedRemedy {
  stated: Money;
  clause_title: string;
}

export type RemedyLookup = (
  breachKind: BreachKind,
  claim: ClaimMessage,
) => StatedRemedy | undefined;

export interface MerchantAgentOptions {
  config: MerchantConfig;
  lookup: RemedyLookup;
  /** Injected so a transcript is byte-identical on every run. */
  clock?: (step: number) => string;
}

const BASE_INSTANT_MS = Date.parse("2026-01-01T00:00:00Z");

/** Credits are issued in round money, so offers land on whole currency units. */
function roundToUnit(amount: WireMoney): WireMoney {
  return { minor: Math.round(amount.minor / 100) * 100, currency: amount.currency };
}

function scale(amount: WireMoney, factor: number): WireMoney {
  return { minor: Math.max(0, Math.round(amount.minor * factor)), currency: amount.currency };
}

function lastCounter(transcript: readonly RecourseMessage[]): CounterMessage | undefined {
  return [...transcript]
    .reverse()
    .find((message): message is CounterMessage => message.type === "COUNTER");
}

function lastOffer(transcript: readonly RecourseMessage[]): OfferMessage | undefined {
  return [...transcript]
    .reverse()
    .find((message): message is OfferMessage => message.type === "OFFER");
}

/**
 * A merchant agent.
 *
 * Pure and deterministic: the same transcript and configuration always produce the same
 * reply. The evaluation drives this function in-process across the whole policy grid;
 * the demo runs the identical function behind an HTTP server so the inspector shows real
 * wire traffic. One strategy, two transports.
 */
export function createMerchantAgent({ config, lookup, clock }: MerchantAgentOptions): Respondent {
  const at = clock ?? ((step: number) => new Date(BASE_INSTANT_MS + step * 60_000).toISOString());
  const route = config.escalation_route ?? `${config.merchant} customer relations`;

  return {
    name: config.merchant,
    respond(transcript: readonly RecourseMessage[]): RespondentMessage {
      const claim = transcript[0];
      if (claim === undefined || claim.type !== "CLAIM") {
        throw new Error("a merchant agent must be given a transcript opening with a CLAIM");
      }

      const step = transcript.length;
      const envelope = { claim_id: claim.claim_id, at: at(step) };
      const breachKind = claim.breach_kind as BreachKind;
      const behaviour = behaviourFor(config, breachKind);
      const remedy = lookup(breachKind, claim);

      if (remedy === undefined) {
        return {
          ...envelope,
          type: "DECLINE",
          reason: "No published remedy covers this claim.",
          escalation_route: route,
        };
      }

      const replyNumber = countRounds(transcript) + 1;
      if (behaviour.declines_at_round > 0 && replyNumber >= behaviour.declines_at_round) {
        return {
          ...envelope,
          type: "DECLINE",
          reason: "We do not consider this claim to fall within the policy as written.",
          escalation_route: route,
        };
      }

      const counter = lastCounter(transcript);
      const stated = remedy.stated;

      if (counter !== undefined && counter.amount.minor <= stated.minor * behaviour.accept_ratio) {
        return { ...envelope, type: "SETTLE", amount: counter.amount, form: "credit" };
      }

      return { ...envelope, type: "OFFER", amount: nextOffer(), form: "credit" };

      function nextOffer(): WireMoney {
        const anchor = roundToUnit(scale(stated, behaviour.anchor_ratio));
        if (counter === undefined) return anchor;

        // The adversarial case: having countered, the household is worse off than if
        // it had simply taken what was first put on the table.
        if (behaviour.withdraws_on_counter) return { minor: 0, currency: stated.currency };

        const previous = lastOffer(transcript)?.amount ?? anchor;
        const gap = counter.amount.minor - previous.minor;
        if (gap <= 0) return previous;
        return roundToUnit({
          minor: previous.minor + Math.round(gap * behaviour.concession_rate),
          currency: previous.currency,
        });
      }
    },
  };
}
