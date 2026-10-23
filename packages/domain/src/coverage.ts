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

/**
 * The per-merchant claim cap — `product_ideation.md` §10, "per-merchant claim frequency cap
 * to avoid vexatious filing".
 *
 * It was the one required safety property in that list with no implementation and no entry
 * in the readme's real-vs-simulated table either, so it was neither built nor disclosed.
 * Three mechanisms already bound the same risk — a claim is idempotent per promise, a claim
 * needs a breach past both gates, and nothing files without the household's yes — but none
 * of them stops a household working through twenty genuine breaches from one merchant in an
 * afternoon, which is the behaviour a merchant would experience as vexatious.
 *
 * Five in seven days, measured against the week the demo records: seven claims across four
 * merchants, at most two per merchant, three for Northwind Parcel once the demo files
 * `prm_011` on camera. The cap therefore sits well clear of the storyboard rather than being
 * a number chosen to look strict.
 */
export const MAX_CLAIMS_PER_MERCHANT = 5;

/** The window that cap is counted over. */
export const CLAIM_WINDOW_DAYS = 7;

export function meetsBreachGate(confidence: Confidence, coverage: Coverage): boolean {
  return confidence >= BREACH_CONFIDENCE_MIN && coverage >= BREACH_COVERAGE_MIN;
}

/** One of §2's two gates. */
export type BreachGate = "confidence" | "coverage";

/**
 * Which gate refused, so the household can be told the true reason.
 *
 * `Suspected` means a broken promise failed **either** gate, and every sentence Owed says
 * about that decision named coverage — "I only watched twenty percent of the window", "because
 * I only watched…", "That isn't enough to say it was broken". None of them looked at
 * confidence. They were true anyway, by an arithmetic coincidence nobody had written down:
 * `confidenceFromCoverage(BREACH_COVERAGE_MIN)` lands exactly on `BREACH_CONFIDENCE_MIN`, so
 * for the coverage-derived detectors the two gates fail together, and every fixed-confidence
 * detector sits at 0.9 or above. Move one of those three constants and Owed would start saying
 * "I only watched ninety-five percent of the window. That isn't enough" — about money, out
 * loud, with every gate green. `coverage.test.ts` pins the calibration; this makes the sentence
 * independent of it.
 *
 * **Coverage first on purpose.** When both gates fail — every reachable case today, including
 * the storyboard's twenty-percent promise — the answer is `"coverage"`, which keeps the spoken
 * line it already produces. The concrete number is also the more credible thing to say.
 */
export function failedBreachGate(
  confidence: Confidence,
  coverage: Coverage,
): BreachGate | undefined {
  if (coverage < BREACH_COVERAGE_MIN) return "coverage";
  if (confidence < BREACH_CONFIDENCE_MIN) return "confidence";
  return undefined;
}

/** Spoken/displayed form of a coverage fraction, e.g. 0.82 -> 82. */
export function coveragePercent(coverage: Coverage): number {
  return Math.round(coverage * 100);
}
