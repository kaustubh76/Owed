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
const DURATION =
  /\b(?:with ?in|in|after)\s+\d{1,3}\s*(?:[-–]\s*\d{1,3})?\s*(?:business\s+|working\s+)?(?:days?|weeks?|months?|years?)\b|\b\d{1,3}[-\s]?(?:month|year)s?\b/gi;

/** A duration in disguise: "3-5 business days" is not an afternoon. */
const TRAILING_UNIT = /^\s*(?:business\s+|working\s+)?(?:days?|weeks?|months?|years?)\b/i;

interface Cue {
  kind: PromiseKind;
  /** Words that tell you what kind of promise a time expression belongs to. */
  pattern: RegExp;
}

/**
 * Cues, most specific first.
 *
 * A time expression on its own says nothing — "between 1 and 5" could be a delivery
 * window, an engineer's visit or a shop's opening hours. What settles it is the words
 * around it, which is also how a person reads the sentence.
 */
const RANGE_CUES: readonly Cue[] = [
  { kind: "appointment_slot", pattern: /appointment|technician|engineer|installer|visit|service call|fitter|plumber|electrician|survey/i },
  { kind: "delivery_window", pattern: /deliver|parcel|package|courier|shipment|dispatch|arriv|drop.?off|order/i },
];

const DEADLINE_CUES: readonly Cue[] = [
  { kind: "refund_sla", pattern: /refund|credit(?:ed)?|money back|reimburs/i },
  { kind: "guarantee", pattern: /guarantee/i },
  { kind: "eta", pattern: /arriv|eta|estimated|driver|ride|pick.?up|on its way|out for delivery|deliver|parcel|package/i },
];

const DURATION_CUES: readonly Cue[] = [
  { kind: "warranty", pattern: /warrant/i },
  { kind: "price_match", pattern: /price (?:match|protection|guarantee|drop|promise)|match the price|price falls|price goes down|cheaper elsewhere/i },
  { kind: "refund_sla", pattern: /refund|credit(?:ed)?|money back|reimburs/i },
  { kind: "guarantee", pattern: /guarantee/i },
];

/** How far back a cue may sit and still be talking about this time expression. */
const NEAR = 70;
const FAR = 150;

function cueFor(cues: readonly Cue[], text: string, index: number): { kind: PromiseKind; confidence: number } | undefined {
  const near = text.slice(Math.max(0, index - NEAR), index + 40);
  for (const cue of cues) if (cue.pattern.test(near)) return { kind: cue.kind, confidence: 0.95 };

  const far = text.slice(Math.max(0, index - FAR), index + 60);
  for (const cue of cues) if (cue.pattern.test(far)) return { kind: cue.kind, confidence: 0.82 };

  return undefined;
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

    const cue = cueFor(RANGE_CUES, text, index);
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

    const cue = cueFor(DEADLINE_CUES, text, index);
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

    const cue = cueFor(DURATION_CUES, text, index);
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
const GUARANTEE_REMEDY =
  /guarantee\w*\b[^.\n]{0,70}?\b(?:or (?:it|the \w+|your \w+)(?:'s| is| are)? (?:free|on us)|or we(?:'ll| will) (?:refund|credit|pay)|or (?:your|the) (?:money back|delivery is free|order is free))/i;

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
