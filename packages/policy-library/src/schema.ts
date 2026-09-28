import * as z from "zod/v4";

/**
 * Machine-readable transcriptions of merchants' own published remedies.
 *
 * Owed's central claim is that it asserts only what a merchant itself promised. That
 * claim rests entirely on these files being faithful, so every clause must carry a
 * `source` and a `quote`: the provenance chain is inspectable rather than asserted.
 *
 * Kept independent of the claimant's domain package so the library is useful on its
 * own — the breach kinds are redeclared here and interoperate structurally.
 */

export const MoneySchema = z.object({
  minor: z.number().int().nonnegative(),
  currency: z.string().regex(/^[A-Z]{3}$/),
});
export type Money = z.infer<typeof MoneySchema>;

export const BreachKindSchema = z.enum([
  "late_eta",
  "missed_window",
  "phantom_delivery",
  "no_show",
  "late_refund",
  "price_drop",
]);
export type BreachKind = z.infer<typeof BreachKindSchema>;

/**
 * `stated` is what the merchant says they pay. `ceiling` is the most their own wording
 * allows. The negotiator may open at the ceiling and never above it.
 */
export const FixedRemedySchema = z.object({
  kind: z.literal("fixed"),
  stated: MoneySchema,
  ceiling: MoneySchema,
});

/** A share of what was at stake, e.g. "10% of the order value, up to $25". */
export const ProportionalRemedySchema = z.object({
  kind: z.literal("proportional"),
  fraction: z.number().positive().max(1),
  floor: MoneySchema.optional(),
  ceiling: MoneySchema,
});

/** Price matches: the household gets back what it lost, capped. */
export const DifferenceRemedySchema = z.object({
  kind: z.literal("difference"),
  ceiling: MoneySchema,
});

export const RemedySchema = z.discriminatedUnion("kind", [
  FixedRemedySchema,
  ProportionalRemedySchema,
  DifferenceRemedySchema,
]);
export type Remedy = z.infer<typeof RemedySchema>;

const NonBlank = z.string().regex(/\S/, "must not be blank");

export const PolicyClauseSchema = z.object({
  /** Stable identifier used as `policy_ref` on the wire. */
  id: NonBlank,
  /** How the clause is named when cited back to the merchant. */
  title: NonBlank,
  breach_kinds: z.array(BreachKindSchema).min(1),
  /** Where this was transcribed from. Without it the clause is hearsay. */
  source: NonBlank,
  /** The merchant's own words, so a reader can check the transcription. */
  quote: NonBlank,
  remedy: RemedySchema,
});
export type PolicyClause = z.infer<typeof PolicyClauseSchema>;

export const MerchantPolicySchema = z.object({
  merchant: NonBlank,
  currency: z.string().regex(/^[A-Z]{3}$/),
  retrieved_at: z.string().optional(),
  clauses: z.array(PolicyClauseSchema).min(1),
});
export type MerchantPolicy = z.infer<typeof MerchantPolicySchema>;
