import { addMs, type Instant, InstantSchema, toEpochMs } from "@owed/domain";
import * as z from "zod/v4";

/**
 * What Alexa+ would have to emit for an add-on to speak first.
 *
 * Alexa+ add-ons are strictly reactive: a tool runs because somebody said something.
 * Owed's entire premise is noticing what the household did *not* ask about — a parcel
 * that never came, a refund that never landed — so "speak first" is not a nice-to-have
 * for this product, it is the product.
 *
 * There is no such channel, so this is the shape we would need, written as a real
 * schema rather than a paragraph in a feedback form. The simulated home delivers these
 * and badges them `simulated proactive`; the protocol inspector shows each one on the
 * wire. Nothing here is a guess at a private API — it is a request, and the fields are
 * the ones a host would actually need in order to decide whether to interrupt somebody.
 *
 * See docs/proactive.md.
 */
export const CommitmentEventSchema = z.object({
  /**
   * Deterministic, derived from the subject and kind rather than random.
   *
   * A host will see the same event again on every poll until it acts on it, and the
   * ledger can be replayed to any instant, so an event needs an identity that survives
   * both. Two announcements about one broken promise is a bug the household hears.
   */
  event_id: z.string().min(1),
  household_id: z.string().min(1),
  kind: z.enum(["promise_breached", "claim_settled", "claim_recovered"]),

  /** When the thing became true — not when the add-on got around to noticing it. */
  occurred_at: InstantSchema,

  /**
   * After this, say nothing.
   *
   * Proactive speech has to be allowed to go stale or it becomes noise: being told on
   * Friday about a parcel that failed on Sunday is worse than silence. A host that
   * cannot deliver inside the window should drop the event, not queue it.
   */
  expires_at: InstantSchema,

  /**
   * Whether this is worth interrupting for. A host cannot make that judgement — only
   * the add-on knows whether money is about to stop being recoverable.
   */
  urgency: z.enum(["low", "normal", "high"]),

  /** Self-sufficient spoken line, under the same voice rules as every tool result. */
  spoken: z.string().min(1),

  subject: z.object({
    promise_id: z.string().min(1),
    merchant: z.string().min(1),
    claim_id: z.string().optional(),
  }),

  /** The card to render where there is a screen. Absent is legitimate: voice is enough. */
  resource_uri: z.string().optional(),

  /**
   * What the household can say next, and the tool it maps to.
   *
   * Without this an announcement is a dead end — the household hears that something is
   * wrong and has to work out for themselves how to ask for it to be fixed.
   */
  offer: z
    .object({
      utterance: z.string().min(1),
      tool: z.string().min(1),
      arguments: z.record(z.string(), z.unknown()),
    })
    .optional(),
});
export type CommitmentEvent = z.infer<typeof CommitmentEventSchema>;

/**
 * How long an announcement stays worth making.
 *
 * Three days is a judgement, not a measurement: long enough to survive a household
 * being out for a weekend, short enough that nothing stale is ever spoken. A merchant
 * that published its own claim window would override this, and none of ours do.
 */
export const COMMITMENT_TTL_MS = 3 * 24 * 60 * 60 * 1000;

export function expiryFor(occurredAt: Instant): Instant {
  return addMs(occurredAt, COMMITMENT_TTL_MS);
}

/** Due now: it has happened, and it has not gone stale. */
export function isDue(event: CommitmentEvent, now: Instant): boolean {
  const at = toEpochMs(now);
  return toEpochMs(event.occurred_at) <= at && at < toEpochMs(event.expires_at);
}
