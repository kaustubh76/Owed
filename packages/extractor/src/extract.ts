import type { Instant, Interval, Money, PromiseKind } from "@owed/domain";
import { addMs, interval, money, toEpochMs } from "@owed/domain";
import {
  type CivilDate,
  type ClockTime,
  civilDateOf,
  inheritMeridiem,
  instantAt,
  parseClockTime,
  parseDuration,
  resolveDate,
} from "./time.js";

export interface ExtractionInput {
  id: string;
  merchant: string;
  /** When the message arrived. Every relative date is resolved against this. */
  received_at: Instant;
  /** The fixed UTC offset this merchant writes times in, e.g. "-07:00". */
  utc_offset: string;
  subject: string;
  body: string;
}

export interface Extraction {
  kind: PromiseKind;
  confidence: number;
  window?: Interval;
  deadline?: Instant;
  amount_at_stake?: Money;
  /**
   * The exact words this was read from.
   *
   * Nothing is extracted without one. A promise a household cannot trace back to a
   * sentence somebody actually wrote them is a promise Owed invented.
   */
  evidence_text: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const CLOCK = String.raw`\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)?|noon|midday|midnight`;

const RANGE = new RegExp(
  String.raw`\b(between\s+)?(${CLOCK})\s*(?:and|to|until|[-–—])\s*(${CLOCK})\b`,
  "gi",
);
const DEADLINE = new RegExp(
  String.raw`\b(?:by|before|no later than|not later than)\s+(${CLOCK})\b`,
  "gi",
);
/**
 * A span of time, however a merchant happens to write it.
 *
 * The lead-in is optional, so "you have 28 days" and "for 30 days" count alongside
 * "within 7 days". A bare number of days is only ever read as a promise when a cue
 * word sits beside it, which is what keeps "only 4 left" and "spend $40 in their first
 * 30 days" out of the results.
 */
const DURATION =
  /\b(?:with ?in|in|after|for|up to|over|of)?\s*(?:the\s+next\s+|their\s+first\s+|a\s+further\s+)?\d{1,3}\s*(?:[-–]\s*\d{1,3})?\s*(?:business\s+|working\s+)?(?:days?|weeks?|months?|years?)\b/gi;

/** A duration in disguise: "3-5 business days" is not an afternoon. */
const TRAILING_UNIT = /^\s*(?:business\s+|working\s+)?(?:days?|weeks?|months?|years?)\b/i;

interface Cue {
  kind: PromiseKind;
  /** Words that tell you what kind of promise a time expression belongs to. */
  pattern: RegExp;
  /**
   * How much closer this cue is treated as being than it really is.
   *
   * Nearness alone is not evidence. "Our engineer will arrive between 10am and 2pm" has
   * a generic verb next to the clock and the noun that actually settles it further away,
   * and the first draft read it as a parcel. A word that can only mean one thing —
   * engineer, warranty, price match — outranks a word that could mean several, even from
   * further back. Far smaller than the penalty for sitting after the clock, so it can
   * never promote a cue across the expression.
   */
  bonus?: number;
}

/**
 * Cues, most specific first.
 *
 * A time expression on its own says nothing — "between 1 and 5" could be a delivery
 * window, an engineer's visit or a shop's opening hours. What settles it is the words
 * around it, which is also how a person reads the sentence.
 */
const RANGE_CUES: readonly Cue[] = [
  {
    kind: "appointment_slot",
    pattern:
      /appointment|technician|engineer|install(?:er|ation)|visit|service call|fitter|plumber|electrician|survey|slot/i,
    bonus: 90,
  },
  {
    kind: "delivery_window",
    pattern: /deliver|parcel|package|courier|shipment|dispatch|arriv|drop.?off|order/i,
  },
];

const DEADLINE_CUES: readonly Cue[] = [
  { kind: "refund_sla", pattern: /refund|credit(?:ed)?|money back|reimburs/i, bonus: 40 },
  { kind: "guarantee", pattern: /guarantee/i, bonus: 90 },
  {
    kind: "eta",
    pattern:
      /arriv|eta|estimated|driver|ride|pick.?up|on its way|out for delivery|deliver|parcel|package|reach you|be with you|lands?\b/i,
  },
];

const DURATION_CUES: readonly Cue[] = [
  {
    kind: "warranty",
    pattern:
      /warrant|cover(?:ed|s|age)? (?:for|runs|lasts)|months? of (?:cover|protection)|manufacturer cover/i,
    bonus: 90,
  },
  {
    kind: "price_match",
    pattern:
      /price (?:match|protection|guarantee|drop|promise)|match the price|price falls|price goes down|gets cheaper|cheaper elsewhere/i,
    bonus: 120,
  },
  { kind: "refund_sla", pattern: /refund|credit(?:ed)?|money back|reimburs/i },
  { kind: "guarantee", pattern: /guarantee/i },
];

/** How far back a cue may sit and still be talking about this time expression. */
const NEAR = 70;
const FAR = 150;
const AHEAD = 60;
/**
 * How much worse a cue is for sitting after the clock rather than before it.
 *
 * English puts the subject first: "your refund will arrive within 7 days" is about a
 * refund, while "arriving by 4pm, and we'll credit you" is about an arrival with a
 * remark after it. Searching a window around the expression treated those the same and
 * read the 4pm deadline as a refund promise, because "credit" sat twelve characters
 * later. Larger than the furthest a cue may be, so any cue before beats any cue after.
 */
const AFTER_PENALTY = 1000;

/** Distance from the end of `text` back to the last match, or undefined. */
function distanceBack(pattern: RegExp, text: string): number | undefined {
  const scan = new RegExp(pattern.source, `${pattern.flags.replace("g", "")}g`);
  let last: number | undefined;
  for (const match of text.matchAll(scan)) last = match.index;
  return last === undefined ? undefined : text.length - last;
}

/** Distance forward from the start of `text` to the first match, or undefined. */
function distanceForward(pattern: RegExp, text: string): number | undefined {
  const match = pattern.exec(text);
  return match === null ? undefined : match.index;
}

/**
 * Which kind of promise a time expression belongs to.
 *
 * The nearest cue wins, and a cue before the expression beats one after it however far
 * away. Cue-list order settles ties only, so adding a kind to the list cannot silently
 * outrank a word sitting right next to the clock.
 */
function cueFor(
  cues: readonly Cue[],
  text: string,
  index: number,
  length: number,
): { kind: PromiseKind; confidence: number } | undefined {
  // The expression's own words count as "before": a duration match can begin at the very
  // word that identifies it, and "covered for 36 months" would otherwise hide the cue
  // inside the span being classified.
  const before = text.slice(Math.max(0, index - FAR), index + length);
  const after = text.slice(index + length, index + length + AHEAD);

  let best: { kind: PromiseKind; score: number } | undefined;
  for (const cue of cues) {
    const backwards = distanceBack(cue.pattern, before);
    const raw =
      backwards !== undefined
        ? backwards
        : (() => {
            const forwards = distanceForward(cue.pattern, after);
            return forwards === undefined ? undefined : AFTER_PENALTY + forwards;
          })();

    if (raw === undefined) continue;
    const score = raw - (cue.bonus ?? 0);
    if (best === undefined || score < best.score) best = { kind: cue.kind, score };
  }

  if (best === undefined) return undefined;
  return { kind: best.kind, confidence: best.score <= NEAR ? 0.95 : 0.82 };
}

function amountIn(text: string): Money | undefined {
  const match = /\$\s?(\d{1,3}(?:,\d{3})*(?:\.\d{2})?)\b/.exec(text);
  if (!match?.[1]) return undefined;
  return money(Math.round(Number(match[1].replace(/,/g, "")) * 100), "USD");
}

/** The sentence a match sits in, so the household can see what was read. */
function sentenceAround(text: string, index: number, length: number): string {
  const start = Math.max(0, text.lastIndexOf(".", index) + 1, text.lastIndexOf("\n", index) + 1);
  const dot = text.indexOf(".", index + length);
  const newline = text.indexOf("\n", index + length);
  const candidates = [dot, newline].filter((position) => position >= 0);
  const end = candidates.length === 0 ? text.length : Math.min(...candidates) + 1;
  return text.slice(start, end).trim();
}

/**
 * Read the promises out of one message.
 *
 * Rules, not a model — the household's principal is a deterministic thing they can
 * audit, and every extraction points at the words it came from. It is worse at prose
 * than a model would be, and eval/README.md reports exactly how much worse.
 */
export function extractPromises(input: ExtractionInput): Extraction[] {
  const text = `${input.subject}\n${input.body}`;
  const received = civilDateOf(input.received_at, input.utc_offset);
  const found: Extraction[] = [];

  for (const match of text.matchAll(RANGE)) {
    const index = match.index ?? 0;
    const [whole, between, rawStart, rawEnd] = match;
    if (rawStart === undefined || rawEnd === undefined) continue;
    // "3-5 business days" is a duration wearing a time range's clothes.
    if (TRAILING_UNIT.test(text.slice(index + whole.length))) continue;

    const parsedStart = parseClockTime(rawStart);
    const parsedEnd = parseClockTime(rawEnd);
    if (!parsedStart || !parsedEnd) continue;
    // Without "between", at least one end has to look like a clock or this is a number range.
    if (between === undefined && !parsedStart.meridiemGiven && !parsedEnd.meridiemGiven) continue;

    const cue = cueFor(RANGE_CUES, text, index, whole.length);
    if (cue === undefined) continue;

    const sentence = sentenceAround(text, index, whole.length);
    const day = resolveDate(sentence, received) ?? resolveDate(text, received) ?? received;
    const amount = amountIn(sentence);
    found.push({
      kind: cue.kind,
      confidence: cue.confidence,
      window: windowFrom(parsedStart, parsedEnd, day, input.utc_offset),
      ...(amount === undefined ? {} : { amount_at_stake: amount }),
      evidence_text: sentence,
    });
  }

  for (const match of text.matchAll(DEADLINE)) {
    const index = match.index ?? 0;
    const [whole, raw] = match;
    if (raw === undefined) continue;
    const parsed = parseClockTime(raw);
    if (!parsed) continue;

    const cue = cueFor(DEADLINE_CUES, text, index, whole.length);
    if (cue === undefined) continue;

    const sentence = sentenceAround(text, index, whole.length);
    const day = resolveDate(sentence, received) ?? received;
    const amount = amountIn(sentence);
    found.push({
      kind: cue.kind,
      confidence: cue.confidence,
      deadline: instantAt(day, parsed.hour, parsed.minute, input.utc_offset),
      ...(amount === undefined ? {} : { amount_at_stake: amount }),
      evidence_text: sentence,
    });
  }

  for (const match of text.matchAll(DURATION)) {
    const index = match.index ?? 0;
    const whole = match[0];
    const duration = parseDuration(whole);
    if (duration === undefined) continue;

    const cue = cueFor(DURATION_CUES, text, index, whole.length);
    if (cue === undefined) continue;

    const sentence = sentenceAround(text, index, whole.length);
    const ends = addMs(input.received_at, duration.days * DAY_MS);
    const covers = cue.kind === "warranty" || cue.kind === "price_match";
    const amount = amountIn(sentence);

    found.push({
      kind: cue.kind,
      confidence: cue.confidence,
      // A warranty or a price promise is a period you are covered for; a refund
      // promise is a moment it has to have happened by.
      ...(covers ? { window: interval(input.received_at, ends) } : { deadline: ends }),
      ...(amount === undefined ? {} : { amount_at_stake: amount }),
      evidence_text: sentence,
    });
  }

  return dedupe([...found, ...guaranteeWithoutAClock(text, found)]);
}

/**
 * A guarantee usually has no clock of its own.
 *
 * "Delivered between one and five, guaranteed or your money back" is two promises to
 * anybody who reads it: a window, and an undertaking about that window. Only the window
 * has a time expression, so the rules above find one promise where a person finds two.
 *
 * Matched on the remedy rather than the word alone, because "guaranteed fresh" and
 * "satisfaction guaranteed" promise nothing anybody could ever collect on.
 */
const REMEDY = String.raw`(?:or (?:it|the \w+|your \w+)(?:'s| is| are)? (?:free|on us)|or we(?:'ll| will) (?:refund|credit|pay)|or (?:your|the) (?:money back|delivery is free|order is free)|we(?:'ll| will) (?:refund|credit) (?:the|you|your))`;
const GUARANTEE_REMEDY = new RegExp(
  // Either order: "guaranteed ... or your money back", or "we'll refund ... that's our
  // guarantee". Merchants write both, and the promise is the same one.
  String.raw`guarantee\w*\b[^.\n]{0,70}?\b${REMEDY}|${REMEDY}[^\n]{0,80}?\bguarantee`,
  "i",
);

function guaranteeWithoutAClock(text: string, found: readonly Extraction[]): Extraction[] {
  if (found.some((item) => item.kind === "guarantee")) return [];
  const match = GUARANTEE_REMEDY.exec(text);
  if (!match) return [];

  // It guarantees whatever the message already committed to, so it borrows that clock.
  // With nothing to borrow there is no promise here anybody could check.
  const host = found.find((item) => item.window !== undefined || item.deadline !== undefined);
  if (host === undefined) return [];

  return [
    {
      kind: "guarantee",
      // A step below a promise that carried its own time, because this one is inferred.
      confidence: 0.8,
      ...(host.window === undefined ? {} : { window: host.window }),
      ...(host.deadline === undefined ? {} : { deadline: host.deadline }),
      ...(host.amount_at_stake === undefined ? {} : { amount_at_stake: host.amount_at_stake }),
      evidence_text: sentenceAround(text, match.index, match[0].length),
    },
  ];
}

function windowFrom(
  rawStart: ClockTime,
  rawEnd: ClockTime,
  day: CivilDate,
  utcOffset: string,
): Interval {
  const [start, end] = inheritMeridiem(rawStart, rawEnd);
  const from = instantAt(day, start.hour, start.minute, utcOffset);
  const to = instantAt(day, end.hour, end.minute, utcOffset);
  // A window that ends before it starts ran past midnight.
  return toEpochMs(to) > toEpochMs(from) ? interval(from, to) : interval(from, addMs(to, DAY_MS));
}

/**
 * One promise per kind per message, keeping the most confident reading.
 *
 * A single sentence often trips two rules — "delivered between 1 and 5pm, guaranteed or
 * your money back" is a delivery window and a guarantee, which is right, while two
 * delivery windows from one sentence is double-counting.
 */
function dedupe(found: readonly Extraction[]): Extraction[] {
  const best = new Map<PromiseKind, Extraction>();
  for (const item of found) {
    const existing = best.get(item.kind);
    if (existing === undefined || item.confidence > existing.confidence) best.set(item.kind, item);
  }
  return [...best.values()];
}
