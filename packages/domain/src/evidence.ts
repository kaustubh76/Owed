import * as z from "zod/v4";
import { EvidenceIdSchema, HouseholdIdSchema, PromiseIdSchema, SourceIdSchema } from "./ids.js";
import { MoneySchema } from "./money.js";
import { InstantSchema, IntervalSchema } from "./time.js";

/** The six evidence kinds — frozen, docs/contract-v1.md §1. */
export const EvidenceKindSchema = z.enum([
  "timestamp",
  "carrier_scan",
  "doorbell_event",
  "doorbell_snapshot",
  "refund_observed",
  "price_observed",
]);
export type EvidenceKind = z.infer<typeof EvidenceKindSchema>;

const evidenceBase = {
  id: EvidenceIdSchema,
  household_id: HouseholdIdSchema,
  source_id: SourceIdSchema,
  captured_at: InstantSchema,
  promise_id: PromiseIdSchema.optional(),
};

export const CarrierScanStatusSchema = z.enum([
  "in_transit",
  "out_for_delivery",
  "delivered",
  "exception",
]);
export type CarrierScanStatus = z.infer<typeof CarrierScanStatusSchema>;

export const DoorbellEventTypeSchema = z.enum([
  "motion",
  "person_detected",
  "package_placed",
  "package_removed",
  "doorbell_pressed",
]);
export type DoorbellEventType = z.infer<typeof DoorbellEventTypeSchema>;

export const TimestampEvidenceSchema = z.object({
  ...evidenceBase,
  kind: z.literal("timestamp"),
  label: z.string().min(1),
});

export const CarrierScanEvidenceSchema = z.object({
  ...evidenceBase,
  kind: z.literal("carrier_scan"),
  status: CarrierScanStatusSchema,
  carrier: z.string().optional(),
});

export const DoorbellEventEvidenceSchema = z.object({
  ...evidenceBase,
  kind: z.literal("doorbell_event"),
  event: DoorbellEventTypeSchema,
});

export const DoorbellSnapshotEvidenceSchema = z.object({
  ...evidenceBase,
  kind: z.literal("doorbell_snapshot"),
  uri: z.string().min(1),
});

export const RefundObservedEvidenceSchema = z.object({
  ...evidenceBase,
  kind: z.literal("refund_observed"),
  amount: MoneySchema,
  reference: z.string().optional(),
});

export const PriceObservedEvidenceSchema = z.object({
  ...evidenceBase,
  kind: z.literal("price_observed"),
  amount: MoneySchema,
  source: z.string().optional(),
});

export const EvidenceSchema = z.discriminatedUnion("kind", [
  TimestampEvidenceSchema,
  CarrierScanEvidenceSchema,
  DoorbellEventEvidenceSchema,
  DoorbellSnapshotEvidenceSchema,
  RefundObservedEvidenceSchema,
  PriceObservedEvidenceSchema,
]);
export type Evidence = z.infer<typeof EvidenceSchema>;
export type CarrierScanEvidence = z.infer<typeof CarrierScanEvidenceSchema>;
export type DoorbellEventEvidence = z.infer<typeof DoorbellEventEvidenceSchema>;
export type RefundObservedEvidence = z.infer<typeof RefundObservedEvidenceSchema>;
export type PriceObservedEvidence = z.infer<typeof PriceObservedEvidenceSchema>;

/**
 * A stretch of time a source was actually watching.
 *
 * Uptime is deliberately separate from the observations recorded inside it: that
 * separation is what lets the system say "the camera was up and saw nothing",
 * which is the whole phantom-delivery signal (plan §2.2b).
 */
export const ObservationWindowSchema = z.object({
  source_id: SourceIdSchema,
  household_id: HouseholdIdSchema,
  interval: IntervalSchema,
});
export type ObservationWindow = z.infer<typeof ObservationWindowSchema>;

/** Everything a breach detector is handed about one promise. */
export const EvidenceBundleSchema = z.object({
  evidence: z.array(EvidenceSchema),
  uptime: z.array(ObservationWindowSchema),
});
export type EvidenceBundle = z.infer<typeof EvidenceBundleSchema>;

export function isCarrierScan(e: Evidence): e is CarrierScanEvidence {
  return e.kind === "carrier_scan";
}

export function isDoorbellEvent(e: Evidence): e is DoorbellEventEvidence {
  return e.kind === "doorbell_event";
}

export function isRefundObserved(e: Evidence): e is RefundObservedEvidence {
  return e.kind === "refund_observed";
}

export function isPriceObserved(e: Evidence): e is PriceObservedEvidence {
  return e.kind === "price_observed";
}
