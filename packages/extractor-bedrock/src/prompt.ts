import type { ExtractionInput } from "@owed/extractor";

/**
 * The seven kinds, spelled exactly as `PromiseKindSchema` spells them.
 *
 * Listed here rather than imported from the schema on purpose: the prompt has to *say* the
 * names, so they end up in a string either way, and a drifting copy would fail loudly in
 * `parse.ts` — which does validate against the real schema — rather than silently
 * accepting a kind the domain does not have. The test pins this list against the schema so
 * the two cannot part company unnoticed.
 */
export const PROMPT_KINDS = [
  "delivery_window",
  "eta",
  "refund_sla",
  "appointment_slot",
  "guarantee",
  "price_match",
  "warranty",
] as const;

/**
 * Turn one merchant message into a prompt.
 *
 * Three things this has to get right, and they are all about making the model's output
 * *checkable* rather than making it good:
 *
 *  1. **Demand the quote.** Every extraction must carry the sentence it was read from,
 *     because that is what the evidence card shows under *they wrote*. The prompt asks for
 *     it verbatim, and `parse.ts` throws away anything whose quote is not literally in the
 *     message. A model that paraphrases loses the extraction rather than inventing words a
 *     merchant never wrote.
 *  2. **Give it the clock.** Every relative date — "tomorrow", "within 3 working days" —
 *     resolves against `received_at` in the merchant's own offset. Without both, the model
 *     has to guess a timezone, and the harness compares instants by exact string equality,
 *     so a guess is a miss.
 *  3. **Permit the empty answer.** A quarter of the corpus promises nothing at all, and
 *     precision is what that half measures. A prompt that implies there is always something
 *     to find is a prompt that manufactures commitments out of shop opening hours and
 *     tracking numbers.
 */
export function buildPrompt(input: ExtractionInput): string {
  return `You read commitments out of merchant email. Extract every promise the merchant makes to the customer about WHEN something will happen, or what they owe if it does not.

The message arrived at ${input.received_at}. The merchant writes all times in UTC offset ${input.utc_offset}. Resolve every relative expression ("tomorrow", "within 3 working days", "by Friday") against that instant and that offset.

Reply with JSON only — an array, no prose, no markdown fences:

[
  {
    "kind": one of ${PROMPT_KINDS.join(" | ")},
    "confidence": a number from 0 to 1,
    "window": { "start": ISO-8601, "end": ISO-8601 },   // omit unless the promise is a span
    "deadline": ISO-8601,                                // omit unless the promise is a single moment
    "amount_at_stake": { "amount_minor": integer, "currency": "GBP" }, // omit unless money is named
    "evidence_text": "the exact sentence from the message this was read from"
  }
]

Rules:
- "evidence_text" must be copied CHARACTER FOR CHARACTER from the subject or body below. Do not paraphrase, trim, tidy punctuation, or join sentences. An extraction whose quote is not found verbatim in the message is discarded.
- Give a "window" OR a "deadline", not both. A delivery between 1pm and 5pm is a window; a refund within 5 days is a deadline.
- Many messages promise NOTHING. Opening hours, sale countdowns, order and tracking numbers, expiring links, a delivery already attempted, and vague reassurance are not promises. For those, reply with exactly: []
- Do not infer a promise the merchant did not make.

Subject: ${input.subject}

Body:
${input.body}`;
}
