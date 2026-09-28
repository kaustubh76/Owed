import * as z from "zod/v4";
import { ClaimIdSchema, EvidenceIdSchema, HouseholdIdSchema, PromiseIdSchema } from "./ids.js";
import { MoneySchema } from "./money.js";
import { InstantSchema } from "./time.js";

export const ClaimStateSchema = z.enum([
  "Proposed",
  "Filed",
  "Negotiating",
  "Settled",
  "Escalated",
  "Recovered",
  "WrittenOff",
]);
export type ClaimState = z.infer<typeof ClaimStateSchema>;

/** The five recourse message types — frozen, docs/contract-v1.md §4. */
export const RecourseMessageTypeSchema = z.enum(["CLAIM", "OFFER", "COUNTER", "SETTLE", "DECLINE"]);
export type RecourseMessageType = z.infer<typeof RecourseMessageTypeSchema>;

export const RemedyFormSchema = z.enum(["credit", "refund", "reship"]);
export type RemedyForm = z.infer<typeof RemedyFormSchema>;

export const JustificationSchema = z.object({
  policy_clause: z.string().min(1),
  evidence_ids: z.array(EvidenceIdSchema),
  coverage_statement: z.string().optional(),
});
export type Justification = z.infer<typeof JustificationSchema>;

/** One message in a negotiation transcript, as recorded on the claim. */
export const ClaimRoundSchema = z.object({
  type: RecourseMessageTypeSchema,
  at: InstantSchema,
  amount: MoneySchema.optional(),
  form: RemedyFormSchema.optional(),
  justification: JustificationSchema.optional(),
  reason: z.string().optional(),
  escalation_route: z.string().optional(),
  reference: z.string().optional(),
});
export type ClaimRound = z.infer<typeof ClaimRoundSchema>;

export const ClaimRouteSchema = z.enum(["agent", "email", "manual"]);
export type ClaimRoute = z.infer<typeof ClaimRouteSchema>;

export const ClaimSchema = z.object({
  id: ClaimIdSchema,
  promise_id: PromiseIdSchema,
  household_id: HouseholdIdSchema,
  merchant: z.string().min(1),
  state: ClaimStateSchema,
  ask: MoneySchema,
  rounds: z.array(ClaimRoundSchema),
  settled_amount: MoneySchema.optional(),
  settled_at: InstantSchema.optional(),
  recovered_amount: MoneySchema.optional(),
  recovered_at: InstantSchema.optional(),
  route: ClaimRouteSchema,
});
export type Claim = z.infer<typeof ClaimSchema>;

const MERCHANT_REPLIES = new Set<RecourseMessageType>(["OFFER", "SETTLE", "DECLINE"]);

/**
 * A round is one completed exchange, counted by the merchant's replies.
 *
 * CLAIM -> OFFER -> COUNTER -> SETTLE is therefore **two** rounds, which is what the
 * storyboard and the card both say.
 */
export function countRounds(rounds: readonly ClaimRound[]): number {
  return rounds.filter((r) => MERCHANT_REPLIES.has(r.type)).length;
}
