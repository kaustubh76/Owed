import * as z from "zod/v4";
import { ConfidenceSchema } from "./coverage.js";
import { HouseholdIdSchema, PromiseIdSchema } from "./ids.js";
import { CurrencySchema, MoneySchema } from "./money.js";
import { InstantSchema, IntervalSchema } from "./time.js";

/** The seven promise kinds — frozen, docs/contract-v1.md §1. */
export const PromiseKindSchema = z.enum([
  "delivery_window",
  "eta",
  "refund_sla",
  "appointment_slot",
  "guarantee",
  "price_match",
  "warranty",
]);
export type PromiseKind = z.infer<typeof PromiseKindSchema>;

export const PromiseStatusSchema = z.enum([
  "Candidate",
  "Captured",
  "Watching",
  "Kept",
  "Suspected",
  "Breached",
  "Filed",
  "Negotiating",
  "Settled",
  "Escalated",
  "Recovered",
  "WrittenOff",
]);
export type PromiseStatus = z.infer<typeof PromiseStatusSchema>;

/**
 * A commitment a merchant made to the household.
 *
 * Named `OwedPromise` rather than `Promise` so it never shadows the JS builtin.
 */
export const PromiseSchema = z.object({
  id: PromiseIdSchema,
  household_id: HouseholdIdSchema,
  merchant: z.string().min(1),
  source_ref: z.string().min(1),
  kind: PromiseKindSchema,
  made_at: InstantSchema,
  window: IntervalSchema.optional(),
  deadline: InstantSchema.optional(),
  amount_at_stake: MoneySchema.optional(),
  currency: CurrencySchema,
  policy_ref: z.string().optional(),
  confidence: ConfidenceSchema,
  status: PromiseStatusSchema,
});
export type OwedPromise = z.infer<typeof PromiseSchema>;

/** Statuses from which no further transition is expected. */
export const TERMINAL_PROMISE_STATUSES: readonly PromiseStatus[] = [
  "Kept",
  "Recovered",
  "WrittenOff",
];

export function isTerminalStatus(status: PromiseStatus): boolean {
  return TERMINAL_PROMISE_STATUSES.includes(status);
}
