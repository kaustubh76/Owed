import * as z from "zod/v4";
import { BreachSchema } from "./breach.js";
import { ClaimRouteSchema, JustificationSchema, RemedyFormSchema } from "./claim.js";
import { EvidenceSchema, ObservationWindowSchema } from "./evidence.js";
import {
  ClaimIdSchema,
  EvidenceIdSchema,
  HouseholdIdSchema,
  IdSchema,
  PromiseIdSchema,
} from "./ids.js";
import { MoneySchema } from "./money.js";
import { PromiseSchema } from "./promise.js";
import { InstantSchema } from "./time.js";

/**
 * `occurred_at` is scenario time — what the ledger replays and the scrubber reads.
 * `recorded_at` is wall time. Conflating them breaks the scrubber (plan §6.4).
 */
const eventBase = {
  id: IdSchema,
  household_id: HouseholdIdSchema,
  occurred_at: InstantSchema,
  recorded_at: InstantSchema,
};

export const PromiseCapturedSchema = z.object({
  ...eventBase,
  type: z.literal("PromiseCaptured"),
  promise: PromiseSchema,
});

export const EvidenceObservedSchema = z.object({
  ...eventBase,
  type: z.literal("EvidenceObserved"),
  evidence: EvidenceSchema,
});

export const SourceUptimeRecordedSchema = z.object({
  ...eventBase,
  type: z.literal("SourceUptimeRecorded"),
  window: ObservationWindowSchema,
});

export const PromiseAssessedSchema = z.object({
  ...eventBase,
  type: z.literal("PromiseAssessed"),
  assessment: BreachSchema,
});

export const ClaimProposedSchema = z.object({
  ...eventBase,
  type: z.literal("ClaimProposed"),
  claim_id: ClaimIdSchema,
  promise_id: PromiseIdSchema,
  merchant: z.string().min(1),
  ask: MoneySchema,
  route: ClaimRouteSchema,
});

export const ClaimFiledSchema = z.object({
  ...eventBase,
  type: z.literal("ClaimFiled"),
  claim_id: ClaimIdSchema,
  promise_id: PromiseIdSchema,
  /** Who said yes. No claim is filed without this (plan §6.6). */
  confirmed_by: z.string().min(1),
  attached_evidence_ids: z.array(EvidenceIdSchema),
});

export const OfferReceivedSchema = z.object({
  ...eventBase,
  type: z.literal("OfferReceived"),
  claim_id: ClaimIdSchema,
  amount: MoneySchema,
  form: RemedyFormSchema,
  terms: z.string().optional(),
});

export const CounterSentSchema = z.object({
  ...eventBase,
  type: z.literal("CounterSent"),
  claim_id: ClaimIdSchema,
  amount: MoneySchema,
  justification: JustificationSchema,
});

export const SettledSchema = z.object({
  ...eventBase,
  type: z.literal("Settled"),
  claim_id: ClaimIdSchema,
  amount: MoneySchema,
  form: RemedyFormSchema,
  reference: z.string().optional(),
  rounds: z.number().int().nonnegative(),
});

export const EscalatedSchema = z.object({
  ...eventBase,
  type: z.literal("Escalated"),
  claim_id: ClaimIdSchema,
  reason: z.string().min(1),
  escalation_route: z.string().min(1),
});

export const RecoveredSchema = z.object({
  ...eventBase,
  type: z.literal("Recovered"),
  claim_id: ClaimIdSchema,
  amount: MoneySchema,
  /** The observed credit. `Recovered` is unreachable without one (plan §6.6). */
  evidence_id: EvidenceIdSchema,
});

export const WrittenOffSchema = z.object({
  ...eventBase,
  type: z.literal("WrittenOff"),
  claim_id: ClaimIdSchema,
  reason: z.string().min(1),
});

/** The twelve ledger events — frozen, docs/contract-v1.md §1. */
export const LedgerEventSchema = z.discriminatedUnion("type", [
  PromiseCapturedSchema,
  EvidenceObservedSchema,
  SourceUptimeRecordedSchema,
  PromiseAssessedSchema,
  ClaimProposedSchema,
  ClaimFiledSchema,
  OfferReceivedSchema,
  CounterSentSchema,
  SettledSchema,
  EscalatedSchema,
  RecoveredSchema,
  WrittenOffSchema,
]);
export type LedgerEvent = z.infer<typeof LedgerEventSchema>;
export type LedgerEventType = LedgerEvent["type"];

/** A ledger event once the store has assigned it a sequence number. */
export type StoredLedgerEvent = LedgerEvent & { seq: number };

export type EventOfType<T extends LedgerEventType> = Extract<LedgerEvent, { type: T }>;
