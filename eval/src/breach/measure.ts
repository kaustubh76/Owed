import { assessPromise } from "@owed/core";
import type { BreachKind, Detection } from "@owed/domain";
import type { BreachCase } from "./corpus.js";
import { CORPUS_PARAMETERS } from "./corpus.js";

export interface CaseOutcome {
  id: string;
  target: BreachKind;
  label: "broken" | "kept";
  observable: boolean;
  /** What the engine said, or `none` where no detector had anything to say. */
  verdict: string;
  detected_kind?: BreachKind;
  coverage?: number;
}

export interface KindReport {
  kind: BreachKind;
  /** Cases at or above the coverage threshold — where H2 makes its claim. */
  observable_cases: number;
  true_positive: number;
  false_positive: number;
  false_negative: number;
  /** Undefined rather than 1 when the engine claimed nothing: there is no rate to report. */
  precision?: number;
  recall?: number;
  kept_cases: number;
  kept_false_positive_rate: number;
  /** Cases below the threshold where the engine correctly refused to claim. */
  held_back: number;
  held_back_cases: number;
  /** Of the breaches it called, how often it named the kind the timeline was written for. */
  kind_agreement?: number;
}

export interface BreachReport {
  parameters: typeof CORPUS_PARAMETERS;
  cases: number;
  by_kind: KindReport[];
  overall: {
    precision?: number;
    recall?: number;
    kept_false_positive_rate: number;
    held_back_share: number;
  };
  /** Cases whose `observable` label disagrees with the coverage the engine measured. */
  mislabelled: CaseOutcome[];
  outcomes: CaseOutcome[];
}

function assessOne(item: BreachCase): Detection | undefined {
  return assessPromise({
    promise: item.promise,
    evidence: item.evidence,
    uptime: item.uptime,
    now: item.now,
  });
}

const ratio = (top: number, bottom: number): number | undefined =>
  bottom === 0 ? undefined : top / bottom;

/**
 * H2, measured.
 *
 * Precision and recall are computed over the cases the corpus marks observable, because
 * that is what the hypothesis claims: "≥ 0.9 precision per breach type at coverage ≥ 0.7".
 * The cases below the threshold are reported separately as restraint — how often Owed
 * refused to claim something that really had been broken. Rolling those into recall would
 * quietly punish the engine for the one behaviour the product most needs it to have.
 */
export function measureBreachDetection(cases: readonly BreachCase[]): BreachReport {
  const outcomes: CaseOutcome[] = [];
  const mislabelled: CaseOutcome[] = [];

  for (const item of cases) {
    const detection = assessOne(item);
    const outcome: CaseOutcome = {
      id: item.id,
      target: item.target,
      label: item.label,
      observable: item.observable,
      verdict: detection?.verdict ?? "none",
      ...(detection === undefined
        ? {}
        : { detected_kind: detection.kind, coverage: detection.coverage }),
    };
    outcomes.push(outcome);

    // The corpus asserts how much of each window was watchable. If the engine measured
    // something else, the timeline was built wrong and every number below it is suspect.
    const coverage = detection?.coverage;
    if (
      coverage !== undefined &&
      item.observable !== coverage >= CORPUS_PARAMETERS.observable_coverage_min
    ) {
      mislabelled.push(outcome);
    }
  }

  const by_kind = CORPUS_PARAMETERS.kinds.map((kind): KindReport => {
    const mine = outcomes.filter((outcome) => outcome.target === kind);
    const claimed = (outcome: CaseOutcome) => outcome.verdict === "Breached";

    const observable = mine.filter((outcome) => outcome.observable);
    const truePositive = observable.filter((o) => o.label === "broken" && claimed(o));
    const falsePositive = observable.filter((o) => o.label === "kept" && claimed(o));
    const falseNegative = observable.filter((o) => o.label === "broken" && !claimed(o));

    const kept = mine.filter((outcome) => outcome.label === "kept");
    const heldBackCases = mine.filter((outcome) => !outcome.observable);

    const agreed = truePositive.filter((o) => o.detected_kind === kind).length;

    return {
      kind,
      observable_cases: observable.length,
      true_positive: truePositive.length,
      false_positive: falsePositive.length,
      false_negative: falseNegative.length,
      ...(ratio(truePositive.length, truePositive.length + falsePositive.length) === undefined
        ? {}
        : { precision: truePositive.length / (truePositive.length + falsePositive.length) }),
      ...(ratio(truePositive.length, truePositive.length + falseNegative.length) === undefined
        ? {}
        : { recall: truePositive.length / (truePositive.length + falseNegative.length) }),
      kept_cases: kept.length,
      kept_false_positive_rate: kept.length === 0 ? 0 : kept.filter(claimed).length / kept.length,
      held_back: heldBackCases.filter((outcome) => !claimed(outcome)).length,
      held_back_cases: heldBackCases.length,
      ...(truePositive.length === 0 ? {} : { kind_agreement: agreed / truePositive.length }),
    };
  });

  const sum = (pick: (report: KindReport) => number) => by_kind.reduce((a, r) => a + pick(r), 0);
  const tp = sum((r) => r.true_positive);
  const fp = sum((r) => r.false_positive);
  const fn = sum((r) => r.false_negative);
  const keptCases = sum((r) => r.kept_cases);
  const keptClaimed = by_kind.reduce(
    (total, r) => total + r.kept_false_positive_rate * r.kept_cases,
    0,
  );
  const heldBackCases = sum((r) => r.held_back_cases);

  return {
    parameters: CORPUS_PARAMETERS,
    cases: cases.length,
    by_kind,
    overall: {
      ...(ratio(tp, tp + fp) === undefined ? {} : { precision: tp / (tp + fp) }),
      ...(ratio(tp, tp + fn) === undefined ? {} : { recall: tp / (tp + fn) }),
      kept_false_positive_rate: keptCases === 0 ? 0 : keptClaimed / keptCases,
      held_back_share: heldBackCases === 0 ? 1 : sum((r) => r.held_back) / heldBackCases,
    },
    mislabelled,
    outcomes,
  };
}
