import {
  type Coverage,
  durationMs,
  fromEpochMs,
  type Interval,
  intersect,
  interval,
  toEpochMs,
} from "@owed/domain";

/** Merge overlapping and adjacent intervals into a sorted, disjoint set. */
export function unionIntervals(intervals: readonly Interval[]): Interval[] {
  const sorted = [...intervals]
    .filter((i) => durationMs(i) > 0)
    .sort((a, b) => toEpochMs(a.start) - toEpochMs(b.start));

  const merged: Interval[] = [];
  for (const current of sorted) {
    const last = merged[merged.length - 1];
    if (last && toEpochMs(current.start) <= toEpochMs(last.end)) {
      if (toEpochMs(current.end) > toEpochMs(last.end)) {
        merged[merged.length - 1] = interval(last.start, current.end);
      }
      continue;
    }
    merged.push(current);
  }
  return merged;
}

/** Total time covered by a set of intervals, counting overlaps once. */
export function measuredMs(intervals: readonly Interval[]): number {
  return unionIntervals(intervals).reduce((total, i) => total + durationMs(i), 0);
}

/**
 * The parts of `evaluation` that at least one of `intervals` covers: clipped, merged,
 * sorted. The single shape both coverage and gaps are read from.
 */
export function observedWithin(intervals: readonly Interval[], evaluation: Interval): Interval[] {
  return unionIntervals(
    intervals.map((i) => intersect(i, evaluation)).filter((i): i is Interval => i !== undefined),
  );
}

/**
 * The fraction of `evaluation` that at least one source was watching.
 *
 * An empty evaluation interval has coverage 1 — there is nothing that could have
 * been missed.
 */
export function measureCoverage(uptime: readonly Interval[], evaluation: Interval): Coverage {
  const total = durationMs(evaluation);
  if (total === 0) return 1;
  return Math.min(1, measuredMs(observedWithin(uptime, evaluation)) / total);
}

/** The parts of `evaluation` nobody was watching — what the card states explicitly. */
export function coverageGaps(uptime: readonly Interval[], evaluation: Interval): Interval[] {
  const covered = observedWithin(uptime, evaluation);

  const gaps: Interval[] = [];
  let cursor = toEpochMs(evaluation.start);
  for (const block of covered) {
    if (toEpochMs(block.start) > cursor) {
      gaps.push(interval(fromEpochMs(cursor), block.start));
    }
    cursor = Math.max(cursor, toEpochMs(block.end));
  }
  const end = toEpochMs(evaluation.end);
  if (cursor < end) gaps.push(interval(fromEpochMs(cursor), fromEpochMs(end)));
  return gaps;
}
