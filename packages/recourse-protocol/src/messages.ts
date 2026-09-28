import * as z from "zod/v4";

/**
 * Recourse protocol v1 — message schemas.
 *
 * Deliberately self-contained: a merchant implementing this must not have to install
 * the claimant's domain package. `Money` and the rest are redeclared here, and because
 * TypeScript is structural they interoperate with an equivalent declaration elsewhere
 * without any adapter.
 */

export const PROTOCOL_VERSION = "recourse/v1";

export const MoneySchema = z.object({
  /** Integer minor units. Never a float. */
  minor: z.number().int(),
  /** ISO-4217, upper case. */
  currency: z.string().regex(/^[A-Z]{3}$/),
});
export type Money = z.infer<typeof MoneySchema>;

/** ISO-8601 with an explicit offset. */
export const InstantSchema = z.string().min(20);

export const IntervalSchema = z.object({ start: InstantSchema, end: InstantSchema });

export const RemedyFormSchema = z.enum(["credit", "refund", "reship"]);
export type RemedyForm = z.infer<typeof RemedyFormSchema>;

/** Enough for the merchant to find the order. Not the claimant's whole record. */
export const PromiseRefSchema = z.object({
  id: z.string().min(1),
  kind: z.string().min(1),
  merchant: z.string().min(1),
  made_at: InstantSchema,
  source_ref: z.string().optional(),
  window: IntervalSchema.optional(),
  deadline: InstantSchema.optional(),
  amount_at_stake: MoneySchema.optional(),
});
export type PromiseRef = z.infer<typeof PromiseRefSchema>;

export const EvidenceItemSchema = z.object({
  id: z.string().min(1),
  kind: z.string().min(1),
  captured_at: InstantSchema,
  uri: z.string().optional(),
});

/**
 * Sent once, with the claim.
 *
 * Later messages reference `id`s from this pack and never re-send the material, so a
 * merchant is not handed the household's evidence again on every round.
 */
export const EvidencePackSchema = z.object({
  items: z.array(EvidenceItemSchema),
  /** Fraction of `evaluation_interval` that some source was actually observing. */
  coverage: z.number().min(0).max(1),
  evaluation_interval: IntervalSchema,
});
export type EvidencePack = z.infer<typeof EvidencePackSchema>;

export const JustificationSchema = z.object({
  /** The merchant's own published clause this counter rests on. */
  policy_clause: z.string().min(1),
  evidence_ids: z.array(z.string().min(1)),
  coverage_statement: z.string().optional(),
});
export type Justification = z.infer<typeof JustificationSchema>;

/** Every message carries the claim id, so a transcript can never be spliced. */
const envelope = {
  claim_id: z.string().min(1),
  at: InstantSchema,
};

export const ClaimMessageSchema = z.object({
  ...envelope,
  type: z.literal("CLAIM"),
  promise: PromiseRefSchema,
  breach_kind: z.string().min(1),
  evidence_pack: EvidencePackSchema,
  /** Which of the merchant's published clauses the claimant is relying on. */
  policy_ref: z.string().optional(),
  ask: MoneySchema,
});

export const OfferMessageSchema = z.object({
  ...envelope,
  type: z.literal("OFFER"),
  amount: MoneySchema,
  form: RemedyFormSchema,
  terms: z.string().optional(),
});

export const CounterMessageSchema = z.object({
  ...envelope,
  type: z.literal("COUNTER"),
  amount: MoneySchema,
  justification: JustificationSchema,
});

export const SettleMessageSchema = z.object({
  ...envelope,
  type: z.literal("SETTLE"),
  amount: MoneySchema,
  form: RemedyFormSchema,
  reference: z.string().optional(),
});

/**
 * Must contain something other than whitespace.
 *
 * `.min(1)` alone would accept "   ", which is how an obligation becomes decorative.
 * A regex rather than `.trim()` because a transform cannot be represented in JSON
 * Schema, and these definitions are published for other implementations to validate
 * against.
 */
const MeaningfulTextSchema = z.string().regex(/\S/, "must not be blank");

export const DeclineMessageSchema = z.object({
  ...envelope,
  type: z.literal("DECLINE"),
  reason: MeaningfulTextSchema,
  /**
   * Required, not optional. A merchant may refuse, but may not leave a household
   * with nowhere to go.
   */
  escalation_route: MeaningfulTextSchema,
});

export const RecourseMessageSchema = z.discriminatedUnion("type", [
  ClaimMessageSchema,
  OfferMessageSchema,
  CounterMessageSchema,
  SettleMessageSchema,
  DeclineMessageSchema,
]);

export type ClaimMessage = z.infer<typeof ClaimMessageSchema>;
export type OfferMessage = z.infer<typeof OfferMessageSchema>;
export type CounterMessage = z.infer<typeof CounterMessageSchema>;
export type SettleMessage = z.infer<typeof SettleMessageSchema>;
export type DeclineMessage = z.infer<typeof DeclineMessageSchema>;
export type RecourseMessage = z.infer<typeof RecourseMessageSchema>;
export type RecourseMessageType = RecourseMessage["type"];

/** What a merchant may say. A merchant never opens a claim and never counters. */
export type RespondentMessage = OfferMessage | SettleMessage | DeclineMessage;
export const RESPONDENT_MESSAGE_TYPES: readonly RecourseMessageType[] = [
  "OFFER",
  "SETTLE",
  "DECLINE",
];

/** A type predicate, so narrowing survives the check. */
export function isRespondentMessage(message: RecourseMessage): message is RespondentMessage {
  return message.type === "OFFER" || message.type === "SETTLE" || message.type === "DECLINE";
}

export const TERMINAL_MESSAGE_TYPES: readonly RecourseMessageType[] = ["SETTLE", "DECLINE"];

export function isTerminal(message: RecourseMessage): boolean {
  return TERMINAL_MESSAGE_TYPES.includes(message.type);
}

/**
 * A round is one completed exchange, counted by the merchant's replies.
 * CLAIM → OFFER → COUNTER → SETTLE is therefore two rounds.
 */
export function countRounds(transcript: readonly RecourseMessage[]): number {
  return transcript.filter((message) => RESPONDENT_MESSAGE_TYPES.includes(message.type)).length;
}

export function sameCurrency(a: Money, b: Money): boolean {
  return a.currency === b.currency;
}
