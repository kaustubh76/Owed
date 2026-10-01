import {
  InstantSchema,
  IntervalSchema,
  MoneySchema,
  normalizeInstant,
  PromiseKindSchema,
} from "@owed/domain";
import type { Extraction, ExtractionInput } from "@owed/extractor";
import { z } from "zod";

/**
 * What the model is allowed to have said.
 *
 * Validated against the real domain schemas rather than a hand-rolled shape, so an
 * unparseable date or an unknown kind fails here instead of becoming a card that shows
 * something impossible. `.loose()` is deliberate: models add fields, and an extra
 * `reasoning` key is not a reason to discard an otherwise good extraction.
 */
const ModelExtractionSchema = z
  .object({
    kind: PromiseKindSchema,
    confidence: z.number().min(0).max(1),
    window: IntervalSchema.optional(),
    deadline: InstantSchema.optional(),
    amount_at_stake: MoneySchema.optional(),
    evidence_text: z.string().min(1),
  })
  .loose();

export interface ParseResult {
  extractions: Extraction[];
  /**
   * Why anything was thrown away, one line each.
   *
   * Returned rather than logged because it is the interesting half of the measurement: an
   * extractor that scores badly because it invented quotes has a different problem from one
   * that scores badly because it cannot read a date, and a number alone cannot tell those
   * apart.
   */
  dropped: string[];
}

/**
 * Turn a model reply into extractions, discarding anything that cannot be trusted.
 *
 * **The evidence guard is the point of this file.** `Extraction.evidence_text` is
 * mandatory, and the source says why: *"Nothing is extracted without one. A promise a
 * household cannot trace back to a sentence somebody actually wrote them is a promise Owed
 * invented."* That is not decoration — `quoteFor()` in the server's storyboard seed sources
 * each card's displayed quote **from the extractor**, specifically so a card cannot show
 * words nothing was read from. A hallucinated quote would put invented sentences on an
 * evidence card under the heading *they wrote*, about a real merchant, in support of a real
 * claim for money.
 *
 * A language model will produce that quote when it cannot find one. So every extraction is
 * checked against the message it supposedly came from, and dropped if the sentence is not
 * there. The model then **fails closed**: a hallucination costs recall, which the
 * evaluation will show, instead of buying confident fiction, which it would not.
 *
 * Note what this does and does not buy. The harness does not score `evidence_text` at all —
 * matching is on `kind` and exact timing. So the guard earns nothing on the scoreboard and
 * may well lower the numbers. It is here because the product's guarantee is worth more than
 * the measurement, and because an extractor that quietly stops honouring that guarantee is
 * worse than one that scores badly.
 */
export function parseExtractions(raw: string, input: ExtractionInput): ParseResult {
  const dropped: string[] = [];

  const json = findJsonArray(raw);
  if (json === undefined) {
    return { extractions: [], dropped: ["reply contained no JSON array"] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    return { extractions: [], dropped: [`reply was not valid JSON: ${String(error)}`] };
  }

  if (!Array.isArray(parsed)) {
    return { extractions: [], dropped: ["reply JSON was not an array"] };
  }

  const haystack = normalizeQuote(`${input.subject}\n${input.body}`);
  const extractions: Extraction[] = [];

  for (const [index, candidate] of parsed.entries()) {
    const result = ModelExtractionSchema.safeParse(candidate);
    if (!result.success) {
      dropped.push(`[${index}] failed schema: ${result.error.issues[0]?.message ?? "unknown"}`);
      continue;
    }
    const value = result.data;

    // The guard. Compared with whitespace collapsed, because a model that re-wraps a line
    // it copied correctly has not invented anything — but nothing beyond whitespace is
    // forgiven, so a paraphrase still fails.
    if (!haystack.includes(normalizeQuote(value.evidence_text))) {
      dropped.push(
        `[${index}] evidence_text is not in the message — discarded as invented: ${truncate(value.evidence_text)}`,
      );
      continue;
    }

    if (value.window === undefined && value.deadline === undefined) {
      dropped.push(`[${index}] ${value.kind} with neither window nor deadline`);
      continue;
    }
    if (value.window !== undefined && value.deadline !== undefined) {
      dropped.push(`[${index}] ${value.kind} claims both a window and a deadline`);
      continue;
    }

    // Instants are normalized so a correct answer written in the merchant's offset compares
    // equal to one written in UTC. The harness matches timing by exact string equality, so
    // without this a right answer in the wrong notation reads as a miss.
    extractions.push({
      kind: value.kind,
      confidence: value.confidence,
      evidence_text: value.evidence_text,
      ...(value.window === undefined
        ? {}
        : {
            window: {
              start: normalizeInstant(value.window.start),
              end: normalizeInstant(value.window.end),
            },
          }),
      ...(value.deadline === undefined ? {} : { deadline: normalizeInstant(value.deadline) }),
      ...(value.amount_at_stake === undefined ? {} : { amount_at_stake: value.amount_at_stake }),
    });
  }

  return { extractions, dropped };
}

/**
 * Find the JSON array in a reply that may not be only JSON.
 *
 * Asking for "JSON only" is a request, not a guarantee. Markdown fences and a line of
 * preamble are the two things models actually do, and both are recoverable without
 * guessing: take the outermost `[` to the last `]`. Anything less tolerant would throw
 * away correct extractions over formatting, and anything more would be parsing prose.
 */
function findJsonArray(raw: string): string | undefined {
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) return undefined;
  return raw.slice(start, end + 1);
}

/** Collapse whitespace and lower-case, so re-wrapping is forgiven and paraphrase is not. */
function normalizeQuote(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function truncate(value: string): string {
  return value.length <= 60 ? value : `${value.slice(0, 57)}...`;
}
