import { type LedgerState, remedyContextFor } from "@owed/core";
import type { BreachKind, Instant } from "@owed/domain";
import { speakMoney, toEpochMs } from "@owed/domain";
import { builtinPolicies, remedyFor } from "@owed/policy-library";
import { VIEW_URIS } from "../views.js";
import { assertSpeakable, joinSpoken } from "../voice.js";
import { type CommitmentEvent, expiryFor, isDue } from "./commitment.js";

/** How each breach kind is put to somebody who did not ask. */
const BREACH_SPOKEN: Readonly<Record<BreachKind, string>> = {
  phantom_delivery: "marked your parcel delivered, and it never arrived",
  missed_window: "missed the delivery window they promised",
  late_eta: "arrived later than they said they would",
  no_show: "did not show up for your appointment",
  late_refund: "still has not refunded you",
  price_drop: "dropped the price after you bought",
};

/**
 * Below this much of the window left, an announcement is worth interrupting for.
 *
 * Urgency has to mean something a host can act on. Here it means: say this now, or the
 * household loses the money.
 */
const URGENT_REMAINING_MS = 24 * 60 * 60 * 1000;

/**
 * Everything Owed would say unprompted at this instant.
 *
 * A pure projection of the ledger, not a queue. That matters more than it looks:
 * the timeline scrubber moves the clock in both directions, and a queue would either
 * replay announcements on the way back or lose them on the way forward. Derived from
 * state, the answer for a given instant is always the same answer.
 *
 * Nothing here decides *delivery*. It says what is true and due; the host decides
 * whether to interrupt, which is the whole reason `urgency` and `expires_at` exist.
 */
export function commitmentsDue(
  state: LedgerState,
  now: Instant,
  householdId: string,
): CommitmentEvent[] {
  const events: CommitmentEvent[] = [];

  for (const view of state.promises.values()) {
    const assessment = view.assessment;
    // Only a promise Owed is sure about. `Suspected` is exactly the case where Owed
    // stays quiet, and speaking first is the last place to start guessing.
    if (assessment === undefined || assessment.verdict !== "Breached") continue;
    // Already filed: the household knows. Nothing to raise.
    if (view.claim_id !== undefined) continue;

    const occurredAt = view.assessed_at ?? assessment.detected_at;
    const expiresAt = expiryFor(occurredAt);
    const merchant = view.promise.merchant;

    const policy = builtinPolicies().get(merchant);
    const remedy =
      policy === undefined
        ? undefined
        : remedyFor(policy, assessment.kind, remedyContextFor(view.promise, view.evidence));

    const owed =
      remedy === undefined
        ? "I can tell you what their policy covers"
        : `They owe you ${speakMoney(remedy.reservation)} under their own policy`;

    events.push({
      event_id: `cme_breach_${view.promise.id}`,
      household_id: householdId,
      kind: "promise_breached",
      occurred_at: occurredAt,
      expires_at: expiresAt,
      urgency: toEpochMs(expiresAt) - toEpochMs(now) <= URGENT_REMAINING_MS ? "high" : "normal",
      spoken: assertSpeakable(
        joinSpoken([`${merchant} ${BREACH_SPOKEN[assessment.kind]}`, owed, "Shall I file it?"]),
      ),
      subject: { promise_id: view.promise.id, merchant },
      // The evidence card, not the claim card: there is no claim yet, and what earns
      // the interruption is precisely what Owed did and did not see.
      resource_uri: VIEW_URIS.evidence,
      offer: {
        utterance: "File it",
        tool: "claim_file",
        arguments: { promise_id: view.promise.id },
      },
    });
  }

  for (const claim of state.claims.values()) {
    if (claim.state === "Recovered" && claim.recovered_at && claim.recovered_amount) {
      events.push({
        event_id: `cme_recovered_${claim.id}`,
        household_id: householdId,
        kind: "claim_recovered",
        occurred_at: claim.recovered_at,
        expires_at: expiryFor(claim.recovered_at),
        urgency: "low",
        spoken: assertSpeakable(`${claim.merchant} paid ${speakMoney(claim.recovered_amount)}.`),
        subject: { promise_id: claim.promise_id, merchant: claim.merchant, claim_id: claim.id },
        resource_uri: VIEW_URIS.claim,
      });
      continue;
    }
    if (claim.state === "Settled" && claim.settled_at && claim.settled_amount) {
      events.push({
        event_id: `cme_settled_${claim.id}`,
        household_id: householdId,
        kind: "claim_settled",
        occurred_at: claim.settled_at,
        expires_at: expiryFor(claim.settled_at),
        urgency: "low",
        spoken: assertSpeakable(
          joinSpoken([
            `${claim.merchant} settled at ${speakMoney(claim.settled_amount)}`,
            "I will tell you when the credit lands",
          ]),
        ),
        subject: { promise_id: claim.promise_id, merchant: claim.merchant, claim_id: claim.id },
        resource_uri: VIEW_URIS.claim,
      });
    }
  }

  return events
    .filter((event) => isDue(event, now))
    .sort((a, b) =>
      a.occurred_at === b.occurred_at
        ? a.event_id.localeCompare(b.event_id)
        : a.occurred_at < b.occurred_at
          ? -1
          : 1,
    );
}
