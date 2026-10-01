import type { Extraction, ExtractionInput } from "@owed/extractor";
import type { Invoke } from "./invoke.js";
import { parseExtractions } from "./parse.js";
import { buildPrompt } from "./prompt.js";

export interface BedrockExtractorOptions {
  invoke: Invoke;
  /**
   * Called for every discarded extraction, with the reason.
   *
   * Optional, and the evaluation runner passes one. A model that scores badly because it
   * invented quotes has a different problem from one that cannot read a date, and the
   * tallies cannot distinguish them — so the reasons have to leave the package somehow.
   */
  onDropped?: (input: ExtractionInput, reasons: readonly string[]) => void;
}

/**
 * A promise extractor backed by a model, satisfying the same job as `extractPromises` —
 * but **not** the same signature.
 *
 * `extractPromises` is synchronous: `(input) => Extraction[]`. A network call cannot be, so
 * this returns a promise and the two are not interchangeable. That difference is the reason
 * the evaluation harness needed a seam rather than a swap, and it is worth stating plainly
 * because "same signature, drop it in" was the assumption that made this look free.
 *
 * A failed call is **not** swallowed into an empty result. An empty array is a real answer
 * here — a quarter of the corpus promises nothing — so returning `[]` when the network
 * failed would quietly report a perfect score on the negatives and a miss on everything
 * else, which reads exactly like a cautious extractor. Throwing keeps "it promised nothing"
 * and "we never asked" distinguishable.
 */
export function createBedrockExtractor({
  invoke,
  onDropped,
}: BedrockExtractorOptions): (input: ExtractionInput) => Promise<Extraction[]> {
  return async (input: ExtractionInput) => {
    const raw = await invoke(buildPrompt(input));
    const { extractions, dropped } = parseExtractions(raw, input);
    if (dropped.length > 0) onDropped?.(input, dropped);
    return extractions;
  };
}
