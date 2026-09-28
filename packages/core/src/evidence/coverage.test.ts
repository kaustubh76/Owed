import { around, coveragePercent, interval, MINUTE_MS } from "@owed/domain";
import { describe, expect, it } from "vitest";
import { coverageGaps, measureCoverage, measuredMs, unionIntervals } from "./coverage.js";

const t = (hhmm: string) => `2026-10-06T${hhmm}:00-07:00`;

describe("unionIntervals", () => {
  it("merges overlapping intervals", () => {
    const merged = unionIntervals([
      interval(t("13:00"), t("14:00")),
      interval(t("13:30"), t("15:00")),
    ]);
    expect(merged).toEqual([interval(t("13:00"), t("15:00"))]);
  });

  it("merges intervals that merely touch", () => {
    const merged = unionIntervals([
      interval(t("13:00"), t("14:00")),
      interval(t("14:00"), t("15:00")),
    ]);
    expect(merged).toHaveLength(1);
  });

  it("keeps disjoint intervals apart and sorted", () => {
    const merged = unionIntervals([
      interval(t("15:00"), t("16:00")),
      interval(t("13:00"), t("14:00")),
    ]);
    expect(merged).toEqual([interval(t("13:00"), t("14:00")), interval(t("15:00"), t("16:00"))]);
  });

  it("drops zero-length intervals", () => {
    expect(unionIntervals([interval(t("13:00"), t("13:00"))])).toEqual([]);
  });

  it("counts overlapping time once", () => {
    const ms = measuredMs([interval(t("13:00"), t("14:00")), interval(t("13:30"), t("14:30"))]);
    expect(ms).toBe(90 * MINUTE_MS);
  });
});

describe("measureCoverage", () => {
  it("is 1 when the whole interval was watched", () => {
    const evaluation = interval(t("13:00"), t("14:00"));
    expect(measureCoverage([evaluation], evaluation)).toBe(1);
  });

  it("is 0 when nothing was watched", () => {
    expect(measureCoverage([], interval(t("13:00"), t("14:00")))).toBe(0);
  });

  it("ignores uptime outside the evaluation interval", () => {
    const coverage = measureCoverage(
      [interval(t("10:00"), t("13:30"))],
      interval(t("13:00"), t("14:00")),
    );
    expect(coverage).toBeCloseTo(0.5, 10);
  });

  it("is 1 for an empty evaluation interval — nothing could have been missed", () => {
    expect(measureCoverage([], interval(t("13:00"), t("13:00")))).toBe(1);
  });

  // The storyboard's hero claim: carrier scan at 14:12, evaluated over 14:12 +/- 30 min,
  // camera up throughout except a gap 13:51-14:02. docs/contract-v1.md §6.
  it("yields the storyboard's 82% for the phantom-delivery claim", () => {
    const evaluation = around(t("14:12"), 30 * MINUTE_MS);
    const uptime = [interval(t("13:42"), t("13:51")), interval(t("14:02"), t("14:42"))];

    expect(coveragePercent(measureCoverage(uptime, evaluation))).toBe(82);
  });

  it("leaves the moment of the scan itself inside a watched stretch", () => {
    const uptime = [interval(t("13:42"), t("13:51")), interval(t("14:02"), t("14:42"))];
    const gaps = coverageGaps(uptime, around(t("14:12"), 30 * MINUTE_MS));

    expect(gaps).toEqual([interval(t("13:51"), t("14:02"))]);
  });
});

describe("coverageGaps", () => {
  it("reports a leading and a trailing gap", () => {
    const gaps = coverageGaps([interval(t("13:20"), t("13:40"))], interval(t("13:00"), t("14:00")));
    expect(gaps).toEqual([interval(t("13:00"), t("13:20")), interval(t("13:40"), t("14:00"))]);
  });

  it("reports the whole interval when nothing was watched", () => {
    const evaluation = interval(t("13:00"), t("14:00"));
    expect(coverageGaps([], evaluation)).toEqual([evaluation]);
  });

  it("reports no gaps under full cover", () => {
    const evaluation = interval(t("13:00"), t("14:00"));
    expect(coverageGaps([interval(t("12:00"), t("15:00"))], evaluation)).toEqual([]);
  });
});
