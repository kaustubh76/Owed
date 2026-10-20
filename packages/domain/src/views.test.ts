import { describe, expect, it } from "vitest";
import { type EvidenceView, evidenceStance, VerdictSchema } from "./index.js";

/**
 * The one decision the card and the spoken line both render.
 *
 * It exists because they disagreed. `watched` was added to `EvidenceView` for the spoken
 * line; `EvidenceCard` went on rendering `VERDICT_LABEL["Undetermined"]` — "still watching" —
 * for a promise nothing was watching, while `docs/contract-v1.md` claimed both read the one
 * field. Pure, so it can be tested without a browser or a component harness, neither of which
 * this repository has.
 */

const base: EvidenceView = {
  promise_id: "prm_1",
  merchant: "Northwind Parcel",
  kind: "warranty",
  status: "Captured",
  gaps: [],
  items: [],
};

describe("what an evidence view says about itself", () => {
  it("reports the verdict whenever there is one", () => {
    for (const verdict of VerdictSchema.options) {
      expect(evidenceStance({ ...base, verdict })).toBe(verdict);
    }
  });

  /** `undefined` is "not yet"; `false` is "not ever". Only the second is worth saying. */
  it("distinguishes not-yet from not-ever", () => {
    expect(evidenceStance(base)).toBe("Undetermined");
    expect(evidenceStance({ ...base, watched: false })).toBe("Unwatched");
    expect(evidenceStance({ ...base, watched: true })).toBe("Undetermined");
  });

  /**
   * A verdict outranks the field.
   *
   * Once something has been judged it was plainly watched, so a stale `watched: false`
   * alongside a verdict must not produce "not watched" over a real finding.
   */
  it("prefers a verdict over a stale watched flag", () => {
    expect(evidenceStance({ ...base, verdict: "Breached", watched: false })).toBe("Breached");
  });
});
