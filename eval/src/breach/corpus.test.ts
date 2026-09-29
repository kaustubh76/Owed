import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type BreachCase, CORPUS_PARAMETERS, generateBreachCorpus } from "./corpus.js";
import { measureBreachDetection } from "./measure.js";

const committed = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../data/corpus/breach.json", import.meta.url)), "utf8"),
) as { parameters: Record<string, unknown>; size: number; cases: BreachCase[] };

/**
 * Pre-registration, enforced — the same protection the merchant grid gets.
 *
 * The corpus was written and committed before the breach engine was touched in response
 * to it. Saying so is worth nothing on its own, so this pins the committed file to the
 * generator: quietly dropping the cases that fail, softening a label, or reordering the
 * set after seeing a disappointing number all turn the suite red.
 */
describe("the pre-registered breach corpus", () => {
  it("still matches the generator, case for case", () => {
    expect(committed.parameters).toEqual(JSON.parse(JSON.stringify(CORPUS_PARAMETERS)));
    expect(committed.size).toBe(60);
    expect(committed.cases).toEqual(JSON.parse(JSON.stringify(generateBreachCorpus())));
  });

  it("still covers every breach kind evenly", () => {
    for (const kind of CORPUS_PARAMETERS.kinds) {
      const mine = committed.cases.filter((item) => item.target === kind);
      expect(mine.length).toBe(CORPUS_PARAMETERS.cases_per_kind);
      expect(mine.some((item) => item.label === "broken")).toBe(true);
      expect(mine.some((item) => item.label === "kept")).toBe(true);
    }
  });

  /**
   * Restraint is the claim the product rests on, so every kind that depends on watching
   * has to be starved more than once. The three kinds read off a clock cannot be
   * starved at all — a clock has no gaps — and are excluded rather than faked.
   */
  it("still starves the camera, for every kind where that is possible", () => {
    for (const kind of ["missed_window", "phantom_delivery", "no_show"]) {
      const starved = committed.cases.filter((item) => item.target === kind && !item.observable);
      expect(starved.length).toBeGreaterThanOrEqual(2);
    }
    expect(committed.cases.filter((item) => !item.observable).length).toBeGreaterThanOrEqual(8);
  });

  it("gives every case a note a human can check the label against", () => {
    for (const item of committed.cases) expect(item.note.length).toBeGreaterThan(10);
  });
});

describe("what the corpus measures", () => {
  const report = measureBreachDetection(generateBreachCorpus());

  /**
   * The corpus states how much of each window was watchable; the engine measures it
   * independently. If they disagree the timeline was built wrong and every number
   * resting on it is suspect. This caught a real one: an appointment-slot case believed
   * starved sat at 0.79 coverage on the reading that actually won, because
   * `missed_window` judges the slot while `no_show` judges the slot plus tolerance.
   */
  it("labels observability the way the engine measures it", () => {
    expect(report.mislabelled).toEqual([]);
  });

  /**
   * The safety invariant, end to end. Not a hypothesis — Owed never files below the
   * gates, and sixty timelines say so alongside the property tests in core.
   */
  it("never claims a breach it could not see enough of", () => {
    for (const outcome of report.outcomes) {
      if (outcome.observable) continue;
      expect(outcome.verdict).not.toBe("Breached");
    }
  });

  /**
   * Deliberately asserts nothing about H2 itself. The threshold is reported by
   * `pnpm --filter @owed/eval breach` and written up in eval/README.md, met or not;
   * a test that went red on a disappointing number would only ever be deleted.
   */
  it("reports a number for every kind", () => {
    expect(report.by_kind.length).toBe(CORPUS_PARAMETERS.kinds.length);
    for (const kind of report.by_kind) expect(kind.observable_cases).toBeGreaterThan(0);
  });
});
