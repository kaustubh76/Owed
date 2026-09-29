import * as z from "zod/v4";

/**
 * An instant in time as an ISO-8601 string with an explicit offset.
 *
 * Parsing a *given* string is deterministic and allowed anywhere. Reading the
 * *current* time is not: that goes through `Clock` in `@owed/core`, which is the
 * only place ambient time may be read (see plan §6.3).
 */
export const InstantSchema = z
  .string()
  .refine((value) => Number.isFinite(Date.parse(value)), "not a parsable ISO-8601 instant")
  .refine(
    (value) => /(?:Z|[+-]\d{2}:?\d{2})$/.test(value),
    "instant must carry an explicit UTC offset",
  );
export type Instant = z.infer<typeof InstantSchema>;

/**
 * Canonical UTC form.
 *
 * Every instant is normalised where it is *produced* — `interval`, `around`, `addMs`,
 * `fromEpochMs` and the scenario helpers all return canonical UTC — so two ways of
 * writing the same moment compare, hash and snapshot identically.
 *
 * It is deliberately not a schema `.transform()`: tool input and output schemas have
 * to serialise to JSON Schema, and a transform cannot. Local-time *display* is a
 * separate concern that takes the household timezone rather than smuggling an offset
 * inside the instant.
 */
export function normalizeInstant(value: string): string {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new TypeError(`not a parsable instant: ${value}`);
  return new Date(ms).toISOString();
}

export function toEpochMs(instant: Instant): number {
  const ms = Date.parse(instant);
  if (!Number.isFinite(ms)) throw new TypeError(`not a parsable instant: ${instant}`);
  return ms;
}

export function fromEpochMs(ms: number): Instant {
  return new Date(ms).toISOString();
}

export function addMs(instant: Instant, ms: number): Instant {
  return fromEpochMs(toEpochMs(instant) + ms);
}

export function compareInstants(a: Instant, b: Instant): number {
  return toEpochMs(a) - toEpochMs(b);
}

export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

/** A half-open interval `[start, end)`. `end` is never before `start`. */
export const IntervalSchema = z
  .object({ start: InstantSchema, end: InstantSchema })
  .refine((i) => toEpochMs(i.end) >= toEpochMs(i.start), "interval end precedes its start");
export type Interval = z.infer<typeof IntervalSchema>;

export function interval(start: Instant, end: Instant): Interval {
  if (toEpochMs(end) < toEpochMs(start)) {
    throw new RangeError(`interval end ${end} precedes start ${start}`);
  }
  return { start: normalizeInstant(start), end: normalizeInstant(end) };
}

/** An interval centred on an instant, `radiusMs` either side. */
export function around(instant: Instant, radiusMs: number): Interval {
  return interval(addMs(instant, -radiusMs), addMs(instant, radiusMs));
}

export function durationMs(i: Interval): number {
  return toEpochMs(i.end) - toEpochMs(i.start);
}

export function isEmptyInterval(i: Interval): boolean {
  return durationMs(i) === 0;
}

export function containsInstant(i: Interval, at: Instant): boolean {
  const ms = toEpochMs(at);
  return ms >= toEpochMs(i.start) && ms < toEpochMs(i.end);
}

/**
 * Whether something landed inside a promised window, counting the closing instant.
 *
 * `containsInstant` is half-open so that adjacent intervals do not double-count, which
 * is what coverage arithmetic needs. A promise is not arithmetic: "delivered by five"
 * includes five, and a parcel scanned at 17:00:00.000 against a window closing at
 * 17:00 has not been delivered late. Use this wherever the question is whether a
 * promise was honoured, and the half-open one wherever the question is how much time
 * was covered.
 */
export function withinWindow(i: Interval, at: Instant): boolean {
  const ms = toEpochMs(at);
  return ms >= toEpochMs(i.start) && ms <= toEpochMs(i.end);
}

export function overlaps(a: Interval, b: Interval): boolean {
  return toEpochMs(a.start) < toEpochMs(b.end) && toEpochMs(b.start) < toEpochMs(a.end);
}

/** The overlap of two intervals, or `undefined` when they do not overlap. */
export function intersect(a: Interval, b: Interval): Interval | undefined {
  const start = Math.max(toEpochMs(a.start), toEpochMs(b.start));
  const end = Math.min(toEpochMs(a.end), toEpochMs(b.end));
  return end > start ? interval(fromEpochMs(start), fromEpochMs(end)) : undefined;
}
