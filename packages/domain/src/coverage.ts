import * as z from "zod/v4";

/** Fraction of a breach detector's evaluation interval that some source was watching. */
export const CoverageSchema = z.number().min(0).max(1);
export type Coverage = z.infer<typeof CoverageSchema>;

export const ConfidenceSchema = z.number().min(0).max(1);
export type Confidence = z.infer<typeof ConfidenceSchema>;

/** Decision gates — docs/contract-v1.md §2. A breach needs both. */
export const BREACH_CONFIDENCE_MIN = 0.85;
export const BREACH_COVERAGE_MIN = 0.7;

/** Default negotiation round cap. */
export const MAX_NEGOTIATION_ROUNDS = 3;

export function meetsBreachGate(confidence: Confidence, coverage: Coverage): boolean {
  return confidence >= BREACH_CONFIDENCE_MIN && coverage >= BREACH_COVERAGE_MIN;
}

/** Spoken/displayed form of a coverage fraction, e.g. 0.82 -> 82. */
export function coveragePercent(coverage: Coverage): number {
  return Math.round(coverage * 100);
}
