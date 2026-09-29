import type { PromiseKind } from "@owed/domain";
import { type Extraction, extractPromises } from "@owed/extractor";
import { EXTRACTION_PARAMETERS, type LabelledMessage } from "./corpus.js";

export interface Tally {
  true_positive: number;
  false_positive: number;
  false_negative: number;
  precision?: number;
  recall?: number;
}

export interface ExtractionReport {
  parameters: typeof EXTRACTION_PARAMETERS;
  messages: number;
  /** Kind only — what H1 claims. */
  kind: { overall: Tally; by_set: Record<string, Tally>; by_kind: Record<string, Tally> };
  /** Kind and the resolved window or deadline. Reported alongside, never instead. */
  exact: { overall: Tally; by_set: Record<string, Tally> };
  /** Messages promising nothing where something was read anyway. */
  false_alarms: Array<{ id: string; set: string; note: string; read: string[] }>;
  misses: Array<{ id: string; set: string; note: string; expected: string[]; read: string[] }>;
}

function emptyTally(): Tally {
  return { true_positive: 0, false_positive: 0, false_negative: 0 };
}

function close(tally: Tally): Tally {
  const positives = tally.true_positive + tally.false_positive;
  const actual = tally.true_positive + tally.false_negative;
  return {
    ...tally,
    ...(positives === 0 ? {} : { precision: tally.true_positive / positives }),
    ...(actual === 0 ? {} : { recall: tally.true_positive / actual }),
  };
}

type Expected = LabelledMessage["expected"][number];

/** Timing counts only where the label states it — H1 is a claim about kinds. */
function timingAgrees(expected: Expected, actual: Extraction): boolean {
  if (expected.window !== undefined) {
    return (
      actual.window?.start === expected.window.start && actual.window.end === expected.window.end
    );
  }
  if (expected.deadline !== undefined) return actual.deadline === expected.deadline;
  return true;
}

/**
 * Match what was read against what was promised, one for one.
 *
 * Greedy, preferring a pairing that also agrees on timing, so a message with two
 * promises of the same kind cannot have one extraction score against both.
 */
function pair(expected: readonly Expected[], actual: readonly Extraction[]) {
  const takenExpected = new Set<number>();
  const takenActual = new Set<number>();
  const matched: Array<{ expected: Expected; actual: Extraction }> = [];

  for (const exact of [true, false]) {
    for (const [ei, want] of expected.entries()) {
      if (takenExpected.has(ei)) continue;
      for (const [ai, got] of actual.entries()) {
        if (takenActual.has(ai) || got.kind !== want.kind) continue;
        if (exact && !timingAgrees(want, got)) continue;
        takenExpected.add(ei);
        takenActual.add(ai);
        matched.push({ expected: want, actual: got });
        break;
      }
    }
  }

  return {
    matched,
    unmatchedExpected: expected.filter((_, i) => !takenExpected.has(i)),
    unmatchedActual: actual.filter((_, i) => !takenActual.has(i)),
  };
}

/**
 * H1, measured.
 *
 * Reported per set, because the generated half is templated and the authored half is
 * prose: rolling them together would let the easy messages carry the hard ones. The
 * twenty-five messages that promise nothing are where precision is actually decided.
 */
export function measureExtraction(corpus: readonly LabelledMessage[]): ExtractionReport {
  const kindOverall = emptyTally();
  const exactOverall = emptyTally();
  const bySet: Record<string, Tally> = {};
  const exactBySet: Record<string, Tally> = {};
  const byKind: Record<string, Tally> = {};
  const false_alarms: ExtractionReport["false_alarms"] = [];
  const misses: ExtractionReport["misses"] = [];

  for (const kind of EXTRACTION_PARAMETERS.kinds) byKind[kind] = emptyTally();
  for (const set of EXTRACTION_PARAMETERS.sets) {
    bySet[set] = emptyTally();
    exactBySet[set] = emptyTally();
  }

  for (const item of corpus) {
    const read = extractPromises(item.input);
    const { matched, unmatchedExpected, unmatchedActual } = pair(item.expected, read);

    const set = bySet[item.set] as Tally;
    const exactSet = exactBySet[item.set] as Tally;

    for (const hit of matched) {
      kindOverall.true_positive += 1;
      set.true_positive += 1;
      (byKind[hit.actual.kind] as Tally).true_positive += 1;

      if (timingAgrees(hit.expected, hit.actual)) {
        exactOverall.true_positive += 1;
        exactSet.true_positive += 1;
      } else {
        // Right kind, wrong clock: a false positive and a miss on the exact reading.
        exactOverall.false_positive += 1;
        exactOverall.false_negative += 1;
        exactSet.false_positive += 1;
        exactSet.false_negative += 1;
      }
    }

    for (const extra of unmatchedActual) {
      kindOverall.false_positive += 1;
      set.false_positive += 1;
      exactOverall.false_positive += 1;
      exactSet.false_positive += 1;
      (byKind[extra.kind] as Tally).false_positive += 1;
    }

    for (const missed of unmatchedExpected) {
      kindOverall.false_negative += 1;
      set.false_negative += 1;
      exactOverall.false_negative += 1;
      exactSet.false_negative += 1;
      (byKind[missed.kind] as Tally).false_negative += 1;
    }

    if (item.expected.length === 0 && read.length > 0) {
      false_alarms.push({
        id: item.input.id,
        set: item.set,
        note: item.note,
        read: read.map((e) => e.kind),
      });
    }
    if (unmatchedExpected.length > 0) {
      misses.push({
        id: item.input.id,
        set: item.set,
        note: item.note,
        expected: unmatchedExpected.map((e) => e.kind),
        read: read.map((e) => e.kind),
      });
    }
  }

  const closeAll = (record: Record<string, Tally>) =>
    Object.fromEntries(Object.entries(record).map(([key, tally]) => [key, close(tally)]));

  return {
    parameters: EXTRACTION_PARAMETERS,
    messages: corpus.length,
    kind: { overall: close(kindOverall), by_set: closeAll(bySet), by_kind: closeAll(byKind) },
    exact: { overall: close(exactOverall), by_set: closeAll(exactBySet) },
    false_alarms,
    misses,
  };
}
