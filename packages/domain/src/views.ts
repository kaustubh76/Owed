import * as z from "zod/v4";
import type { Verdict } from "./breach.js";
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
  /**
   * Whether anything is actually watching this promise.
   *
   * `false` means no detector covers it, so no verdict is coming — a state the card and the
   * spoken line both used to render as "still watching". One field so the two cannot
   * disagree, which is the rule the rest of this view already follows.
   */
  watched: z.boolean().optional(),
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

/**
 * What an evidence view says about itself, as one key.
 *
 * The card and the spoken line both render this and neither decides it, which is the only
 * way they can be kept from disagreeing. They did disagree: `watched` was added for the
 * spoken line and the card went on rendering `VERDICT_LABEL["Undetermined"]` — "still
 * watching" — for a promise nothing was watching, while `docs/contract-v1.md` claimed both
 * read the one field. One function, two renderers, and a label map keyed by this union so a
 * missing case fails to compile rather than rendering `undefined`.
 */
export type EvidenceStance = Verdict | "Unwatched";

export function evidenceStance(view: EvidenceView): EvidenceStance {
  if (view.verdict !== undefined) return view.verdict;
  // `undefined` is "not yet", `false` is "not ever". Only the second is worth saying.
  return view.watched === false ? "Unwatched" : "Undetermined";
}
