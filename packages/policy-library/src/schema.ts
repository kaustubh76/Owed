import { MoneySchema as ProtocolMoneySchema } from "@owed/recourse-protocol";
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

/**
 * The protocol's money, with the one constraint a published remedy adds.
 *
 * This package declared `@owed/recourse-protocol` as a dependency and then defined its own
 * `MoneySchema` anyway, which made `Money` a third definition in a workspace that needs two:
 * `@owed/domain` has one for internal use and is `private`, and the protocol has one because
 * it is published with no dependencies of its own. A third copy in a package that already
 * depends on the protocol was the one that could not be justified.
 *
 * Extended rather than re-exported, because the two were **not** the same shape and the
 * difference is worth keeping: the protocol permits a negative `minor` — a counter-offer or
 * an adjustment can legitimately be negative on the wire — while a figure a merchant
 * *publishes* as a remedy cannot be. Swapping in the protocol's schema unchanged would have
 * quietly widened this package's validation, so the stricter rule is stated here instead of
 * being lost. Verified by comparing the two schemas against the same inputs rather than by
 * reading them: `{ minor: -1 }` parses as protocol money and is refused as a published remedy.
 */
export const MoneySchema = ProtocolMoneySchema.extend({
  minor: z.number().int().nonnegative(),
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
  /**
   * Where a claim goes when no agent answers.
   *
   * Optional, because most merchants publish a remedy without publishing anywhere to
   * send it — and the difference matters to the household: with a contact, Owed can say
   * who to send the claim to; without one, all it can honestly do is record what is owed
   * and hand it over. That is the distinction `ClaimRoute`'s `email` and `manual` members
   * were declared for.
   */
  claims_contact: NonBlank.optional(),
  clauses: z.array(PolicyClauseSchema).min(1),
});
export type MerchantPolicy = z.infer<typeof MerchantPolicySchema>;
