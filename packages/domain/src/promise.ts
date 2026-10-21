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

/**
 * The kinds whose verdict comes from another promise rather than from evidence.
 *
 * A `guarantee` or a `warranty` has none of its own — there is no doorbell event for "or your
 * money back" — so `derivedBreach` gives it the verdict of a promise read from the same
 * merchant message. Declared here, with the schema, because four different things need to
 * know and each one got it wrong in turn when the rule lived only inside the detector:
 * the proactive channel announced the pair twice, `summarize` tallied it twice, `claim_file`
 * could file it twice, and the spoken summary offered to file it twice.
 *
 * Kind-level because that is the whole of the rule — `derivedBreach.appliesTo` tests nothing
 * else — and because the ledger's own items carry a `kind` and not a promise, so this is the
 * only form the voice can use.
 */
export const DERIVED_PROMISE_KINDS: readonly PromiseKind[] = ["guarantee", "warranty"];

export function isDerivedKind(kind: PromiseKind): boolean {
  return DERIVED_PROMISE_KINDS.includes(kind);
}

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
  /**
   * The merchant's own words this promise was read out of.
   *
   * Carried on the promise rather than looked up, because it has to survive into the
   * ledger: a card telling a household "they promised one to five" is worth nothing
   * unless it can also show them the sentence somebody wrote. Absent for a promise
   * captured some other way, and the card simply says less.
   */
  source_quote: z.string().min(1).optional(),
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
