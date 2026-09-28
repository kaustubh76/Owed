import * as z from "zod/v4";
import { ConfidenceSchema, CoverageSchema } from "./coverage.js";
import { BreachIdSchema, EvidenceIdSchema, PromiseIdSchema } from "./ids.js";
import { InstantSchema, IntervalSchema } from "./time.js";

/** The six breach kinds — frozen, docs/contract-v1.md §1. */
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
 * What the engine concluded about a promise.
 *
 * `Suspected` is the honest middle: the deadline passed but the evidence gate was
 * not met, so Owed says what it did and did not see rather than claiming.
 */
export const VerdictSchema = z.enum(["Kept", "Suspected", "Breached", "Undetermined"]);
export type Verdict = z.infer<typeof VerdictSchema>;

/**
 * A detector's output for one promise.
 *
 * `evaluation_interval` is chosen by the detector, not fixed to the promise window —
 * for a phantom delivery it is the carrier scan plus or minus a tolerance
 * (plan §2.2a). `coverage` is measured over exactly this interval.
 */
export const DetectionSchema = z.object({
  promise_id: PromiseIdSchema,
  kind: BreachKindSchema,
  verdict: VerdictSchema,
  confidence: ConfidenceSchema,
  coverage: CoverageSchema,
  evaluation_interval: IntervalSchema,
  evidence_ids: z.array(EvidenceIdSchema),
  explanation: z.string().min(1),
});
export type Detection = z.infer<typeof DetectionSchema>;

/** A detection once it has been written to the ledger. */
export const BreachSchema = DetectionSchema.extend({
  id: BreachIdSchema,
  detected_at: InstantSchema,
});
export type Breach = z.infer<typeof BreachSchema>;

export function isActionable(detection: Detection): boolean {
  return detection.verdict === "Breached";
}
