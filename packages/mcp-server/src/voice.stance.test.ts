import {
  type EvidenceView,
  evidenceStance,
  type LedgerSummaryView,
  usd,
  VerdictSchema,
} from "@owed/domain";
import { STANCE_LABEL } from "@owed/ui-views";
import { describe, expect, it } from "vitest";
import { MAX_SPOKEN_CHARS, speakLedgerSummary, speakPromiseCheck } from "./voice.js";

/**
 * The card and the spoken line, over every stance there is.
 *
 * `docs/contract-v1.md` claims they read one field and cannot disagree. They did: `watched`
 * was added for the spoken line, and `EvidenceCard` kept rendering "still watching" for a
 * promise nothing was watching. This is the assertion that makes the claim true rather than
 * written down — the only place both renderers can be reached from, since `mcp-server` holds
 * the voice and imports `@owed/ui-views` for the view contract.
 *
 * No component harness is involved, and none exists in this repository: the label map is a
 * plain `Record<EvidenceStance, string>` in `ui-views/src/evidence/labels.ts`, so the card is
 * a consumer of something testable rather than the only place the decision lives.
 */

const STANCES = [...VerdictSchema.options, "Unwatched"] as const;

function viewFor(stance: (typeof STANCES)[number]): EvidenceView {
  const base: EvidenceView = {
    promise_id: "prm_1",
    merchant: "Northwind Parcel",
    kind: "warranty",
    status: "Captured",
    gaps: [],
    items: [],
  };
  if (stance === "Unwatched") return { ...base, watched: false };
  return { ...base, verdict: stance, coverage: 0.9 };
}

describe("every stance a view can take", () => {
  it("has a label on the card", () => {
    for (const stance of STANCES) {
      expect(STANCE_LABEL[stance], stance).toBeDefined();
      expect(STANCE_LABEL[stance]?.length ?? 0, stance).toBeGreaterThan(0);
    }
    // Exactly these, so adding one is deliberate in all three places rather than a label
    // that quietly renders `undefined`.
    expect(Object.keys(STANCE_LABEL).toSorted()).toStrictEqual([...STANCES].toSorted());
  });

  it("has a spoken line, and it is speakable", () => {
    for (const stance of STANCES) {
      const spoken = speakPromiseCheck(viewFor(stance));
      expect(spoken.length, stance).toBeGreaterThan(0);
      expect(spoken.length, stance).toBeLessThanOrEqual(MAX_SPOKEN_CHARS);
      expect(spoken, `${stance} spoke a digit`).not.toMatch(/[0-9]/);
    }
  });

  /**
   * The agreement that matters, in the direction that was wrong.
   *
   * Only `Undetermined` may claim to be watching. Everything else — including `Unwatched`,
   * which is the whole point — must not, in either renderer.
   */
  it("claims to be watching in exactly one stance, on the card and out loud", () => {
    for (const stance of STANCES) {
      const claimsWatching = speakPromiseCheck(viewFor(stance)).includes("still watching");
      const cardSaysWatching = STANCE_LABEL[stance] === "still watching";

      expect(claimsWatching, `spoken, ${stance}`).toBe(stance === "Undetermined");
      expect(cardSaysWatching, `card, ${stance}`).toBe(stance === "Undetermined");
      expect(claimsWatching, `card and voice disagree for ${stance}`).toBe(cardSaysWatching);
    }
  });

  it("derives the stance from the view, so a verdict outranks a stale flag", () => {
    expect(evidenceStance({ ...viewFor("Breached"), watched: false })).toBe("Breached");
  });
});

/**
 * Which of §2's two gates refused, in the two sentences that read a view rather than a detection.
 *
 * `Suspected` needs only one gate to fail, and both of these said the window was too small. A
 * phantom delivery whose claimed moment fell inside a gap takes
 * `confidenceFromCoverage(coverage) * 0.6` — **at most 0.6 whatever the coverage** — so a camera
 * up ninety-five percent of the window that blinked at the delivery moment failed on confidence
 * alone, and Owed told the household it was the window. Not a hypothetical: that multiplier is
 * `detectors.ts:270` and the reason §2 gives for it is exactly this case.
 *
 * Both branches are pinned, because the coverage wording is what the storyboard says and the
 * capture quotes.
 */
describe("saying which gate refused", () => {
  const suspected = (coverage: number, confidence: number): EvidenceView => ({
    promise_id: "prm_010",
    merchant: "Northwind Parcel",
    kind: "delivery_window",
    status: "Suspected",
    verdict: "Suspected",
    coverage,
    confidence,
    gaps: [],
    items: [],
  });

  const summaryWith = (coverage: number, confidence: number): LedgerSummaryView => ({
    currency: "USD",
    recovered: usd(47),
    open: usd(8),
    kept: 0,
    declined: 1,
    items: [
      {
        promise_id: "prm_010",
        merchant: "Northwind Parcel",
        kind: "delivery_window",
        status: "Suspected",
        coverage,
        confidence,
      },
    ],
    period: "week",
    as_of: "2026-10-19T19:30:00-07:00",
  });

  it("blames the window when the window failed", () => {
    // The storyboard's own case: a fifth of the window, where both gates fail.
    expect(speakPromiseCheck(suspected(0.2, 0.36))).toContain("That isn't enough to be sure");
    expect(speakLedgerSummary(summaryWith(0.2, 0.36))).toContain(
      "because I only watched twenty percent of the window",
    );
  });

  it("blames its own certainty when the window was watched and it still is not sure", () => {
    const spoken = speakPromiseCheck(suspected(0.95, 0.585));

    expect(spoken).toContain("I watched ninety-five percent of the window");
    expect(spoken).toContain("I still can't be sure what happened");
    expect(spoken, "the window was plenty").not.toContain("That isn't enough to be sure");

    const summary = speakLedgerSummary(summaryWith(0.95, 0.585));

    expect(summary).toContain("I saw enough of the window, but I couldn't be sure enough");
    expect(summary, "it must not blame a window it was happy with").not.toContain("I only watched");
  });
});
