import * as z from "zod/v4";

export const IdSchema = z.string().min(1);
export const HouseholdIdSchema = IdSchema;
export const PromiseIdSchema = IdSchema;
export const EvidenceIdSchema = IdSchema;
export const ClaimIdSchema = IdSchema;
export const BreachIdSchema = IdSchema;
export const SourceIdSchema = IdSchema;
