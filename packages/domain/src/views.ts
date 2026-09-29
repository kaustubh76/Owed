import * as z from "zod/v4";
import { ClaimRoundSchema, ClaimStateSchema } from "./claim.js";
import { CoverageSchema } from "./coverage.js";
import { EvidenceKindSchema } from "./evidence.js";
import { CurrencySchema, MoneySchema } from "./money.js";
import { PromiseKindSchema, PromiseStatusSchema } from "./promise.js";
import { InstantSchema, IntervalSchema } from "./time.js";

/**
 * The shapes carried in `structuredContent` and rendered by the `ui://owed/*` views.
 *
 * These are boundary contracts, so they live here as schemas and are used directly
 * as each tool's `outputSchema` — spec and code cannot drift (plan §6.1).
 */

export const LedgerSummaryItemSchema = z.object({
  promise_id: z.string(),
  merchant: z.string(),
  kind: PromiseKindSchema,
  status: PromiseStatusSchema,
  amount: MoneySchema.optional(),
  claim_id: z.string().optional(),
  coverage: CoverageSchema.optional(),
});
export type LedgerSummaryItem = z.infer<typeof LedgerSummaryItemSchema>;

/** What the ledger projection computes. */
export const LedgerTotalsSchema = z.object({
  currency: CurrencySchema,
  recovered: MoneySchema,
  open: MoneySchema,
  kept: z.number().int().nonnegative(),
  declined: z.number().int().nonnegative(),
  items: z.array(LedgerSummaryItemSchema),
});
export type LedgerTotals = z.infer<typeof LedgerTotalsSchema>;

export const LedgerPeriodSchema = z.enum(["week", "month"]);
export type LedgerPeriod = z.infer<typeof LedgerPeriodSchema>;

/** `ledger_summary` output — rendered by `ui://owed/ledger`. */
export const LedgerSummaryViewSchema = LedgerTotalsSchema.extend({
  period: LedgerPeriodSchema,
  as_of: InstantSchema,
});
export type LedgerSummaryView = z.infer<typeof LedgerSummaryViewSchema>;

/** `claim_status` and `claim_file` output — rendered by `ui://owed/claim`. */
export const ClaimViewSchema = z.object({
  claim_id: z.string(),
  promise_id: z.string(),
  merchant: z.string(),
  state: ClaimStateSchema,
  ask: MoneySchema,
  /** What the merchant published, and therefore what is actually at stake. */
  expected: MoneySchema,
  settled_amount: MoneySchema.optional(),
  recovered_amount: MoneySchema.optional(),
  rounds: z.array(ClaimRoundSchema),
  round_count: z.number().int().nonnegative(),
});
export type ClaimView = z.infer<typeof ClaimViewSchema>;

/** `promise_check` and `evidence_get` output — rendered by `ui://owed/evidence`. */
export const EvidenceViewSchema = z.object({
  promise_id: z.string(),
  merchant: z.string(),
  kind: PromiseKindSchema,
  status: PromiseStatusSchema,
  verdict: z.enum(["Kept", "Suspected", "Breached", "Undetermined"]).optional(),
  coverage: CoverageSchema.optional(),
  evaluation_interval: IntervalSchema.optional(),
  /** The stretches nobody was watching, stated rather than glossed over. */
  gaps: z.array(IntervalSchema),
  /** The merchant's own sentence the promise was read out of, where there is one. */
  promised_in: z.string().optional(),
  explanation: z.string().optional(),
  items: z.array(
    z.object({
      evidence_id: z.string(),
      kind: EvidenceKindSchema,
      captured_at: InstantSchema,
      uri: z.string().optional(),
      detail: z.string().optional(),
    }),
  ),
});
export type EvidenceView = z.infer<typeof EvidenceViewSchema>;
