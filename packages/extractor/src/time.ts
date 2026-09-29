import { type Instant, normalizeInstant, toEpochMs } from "@owed/domain";

/**
 * Civil time, resolved against a fixed UTC offset.
 *
 * A real deployment needs a timezone database: "Tuesday at 1pm" in Los Angeles is a
 * different instant in March than in December. A fixed offset is honest for a seeded
 * corpus and wrong for the world, and the limitation is stated rather than hidden —
 * every input carries the offset its merchant writes times in.
 */
export interface CivilDate {
  year: number;
  month: number;
  day: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function offsetMs(utcOffset: string): number {
  const match = /^([+-])(\d{2}):(\d{2})$/.exec(utcOffset);
  if (!match) return 0;
  const [, sign, hours, minutes] = match as unknown as [string, string, string, string];
  const magnitude = Number(hours) * 60 + Number(minutes);
  return (sign === "-" ? -magnitude : magnitude) * 60_000;
}

export function civilDateOf(instant: Instant, utcOffset: string): CivilDate {
  const local = new Date(toEpochMs(instant) + offsetMs(utcOffset));
  return {
    year: local.getUTCFullYear(),
    month: local.getUTCMonth() + 1,
    day: local.getUTCDate(),
  };
}

export function addDays(date: CivilDate, days: number): CivilDate {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day) + days * DAY_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

/** Day of the week, 0 = Sunday, for a civil date. */
export function weekdayOf(date: CivilDate): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

const pad = (n: number) => String(n).padStart(2, "0");

export function instantAt(
  date: CivilDate,
  hour: number,
  minute: number,
  utcOffset: string,
): Instant {
  return normalizeInstant(
    `${date.year}-${pad(date.month)}-${pad(date.day)}T${pad(hour)}:${pad(minute)}:00${utcOffset}`,
  );
}

// --- reading times and dates out of prose ----------------------------------

export const WEEKDAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;

export const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
] as const;

export interface ClockTime {
  hour: number;
  minute: number;
  /** Whether the text said am/pm. A bare "5" in a range inherits it from the other end. */
  meridiemGiven: boolean;
}

/** `1pm`, `1:30 PM`, `13:00`, `noon`, `midnight`, or a bare `5` inside a range. */
export function parseClockTime(text: string): ClockTime | undefined {
  const trimmed = text.trim().toLowerCase();
  if (trimmed === "noon" || trimmed === "midday")
    return { hour: 12, minute: 0, meridiemGiven: true };
  if (trimmed === "midnight") return { hour: 0, minute: 0, meridiemGiven: true };

  const match = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?$/.exec(trimmed);
  if (!match) return undefined;

  const [, rawHour, rawMinute, rawMeridiem] = match;
  let hour = Number(rawHour);
  const minute = rawMinute === undefined ? 0 : Number(rawMinute);
  if (hour > 23 || minute > 59) return undefined;

  const meridiem = rawMeridiem?.replace(/\./g, "");
  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;

  return { hour, minute, meridiemGiven: meridiem !== undefined };
}

/**
 * Give a bare hour the same half of the day as its partner.
 *
 * "between 1 and 5pm" means the afternoon, and reading the 1 as 01:00 would put the
 * window twelve hours before anything it describes.
 */
export function inheritMeridiem(start: ClockTime, end: ClockTime): [ClockTime, ClockTime] {
  if (start.meridiemGiven || !end.meridiemGiven) return [start, end];
  const shifted = end.hour >= 12 && start.hour < 12 ? start.hour + 12 : start.hour;
  // A range must move forward: "between 11 and 1pm" stays in the morning at its start.
  const candidate = { ...start, hour: shifted, meridiemGiven: true };
  return candidate.hour <= end.hour ? [candidate, end] : [start, end];
}

/**
 * The civil date a phrase refers to, relative to when the message arrived.
 *
 * Returns undefined when the text names no date at all, which the caller reads as
 * "the day the message arrived".
 */
export function resolveDate(
  text: string,
  received: CivilDate,
  ordering: "next" | "same" = "next",
): CivilDate | undefined {
  const lower = text.toLowerCase();

  if (/\btoday\b|\bthis afternoon\b|\bthis morning\b|\bthis evening\b/.test(lower)) return received;
  if (/\btomorrow\b/.test(lower)) return addDays(received, 1);

  const named =
    /\b(\d{1,2})(?:st|nd|rd|th)?\s+(january|february|march|april|may|june|july|august|september|october|november|december)\b/.exec(
      lower,
    );
  if (named) {
    const month = MONTHS.indexOf(named[2] as (typeof MONTHS)[number]) + 1;
    return withYear(received, month, Number(named[1]));
  }

  const american =
    /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})(?:st|nd|rd|th)?\b/.exec(
      lower,
    );
  if (american) {
    const month = MONTHS.indexOf(american[1] as (typeof MONTHS)[number]) + 1;
    return withYear(received, month, Number(american[2]));
  }

  for (const [index, name] of WEEKDAYS.entries()) {
    if (!new RegExp(`\\b${name}\\b`).test(lower)) continue;
    const today = weekdayOf(received);
    let ahead = (index - today + 7) % 7;
    // "on Monday" in a message that arrived on Monday means today only if we say so.
    if (ahead === 0 && ordering === "next") ahead = 7;
    return addDays(received, ahead);
  }

  return undefined;
}

/** Roll a bare day-and-month into the next occurrence, so December wraps to next year. */
function withYear(received: CivilDate, month: number, day: number): CivilDate {
  const sameYear = { year: received.year, month, day };
  const receivedMs = Date.UTC(received.year, received.month - 1, received.day);
  const candidateMs = Date.UTC(sameYear.year, month - 1, day);
  // More than a fortnight in the past reads as next year rather than a typo.
  return candidateMs < receivedMs - 14 * DAY_MS
    ? { ...sameYear, year: received.year + 1 }
    : sameYear;
}

export interface Duration {
  days: number;
  text: string;
}

const UNIT_DAYS: Readonly<Record<string, number>> = {
  day: 1,
  days: 1,
  week: 7,
  weeks: 7,
  month: 30,
  months: 30,
  year: 365,
  years: 365,
};

/**
 * `within 7 days`, `in 3-5 business days`, `2 years`, `12 months`.
 *
 * A range takes its longer end: the promise is the outer bound, and holding a merchant
 * to the optimistic end of their own estimate is not what they said.
 */
export function parseDuration(text: string): Duration | undefined {
  const match =
    /\b(?:with ?in|in|after|for|up to|over|of)?\s*(?:the\s+next\s+|their\s+first\s+|a\s+further\s+)?(\d{1,3})\s*(?:[-–to]{1,3}\s*(\d{1,3}))?\s*(?:business\s+|working\s+)?(days?|weeks?|months?|years?)\b/i.exec(
      text,
    );
  if (!match) return undefined;

  const [whole, first, second, unit] = match;
  if (whole === undefined || first === undefined || unit === undefined) return undefined;
  const count = Number(second ?? first);
  const perUnit = UNIT_DAYS[unit.toLowerCase()];
  if (perUnit === undefined) return undefined;

  return { days: count * perUnit, text: whole.trim() };
}
