import { usd } from "@owed/domain";
import { describe, expect, it } from "vitest";
import { SeededIdGen } from "../time/determinism.js";
import {
  capturePromises,
  type ReadPromise,
  statusForConfidence,
  TRACKING_CONFIDENCE,
} from "./capture.js";
import { project } from "./projections.js";

/**
 * Turning what an extractor read into a ledger entry.
 *
 * This is the step that did not exist. `PromiseStatus` has had `Candidate` and `Captured`
 * since it was declared and `ui-views/src/ledger/labels.ts` has had a label and a sort
 * rank for each — "not yet tracked" and "captured" — while nothing produced either: the
 * seeded week writes its promises in directly as `Watching`, and the extractor was used
 * only to recover the sentence behind one of them.
 */

const HH = "hh_capture";
const AT = "2026-10-11T04:15:00-07:00";

const read = (over: Partial<ReadPromise> = {}): ReadPromise => ({
  kind: "delivery_window",
  confidence: 0.95,
  evidence_text: "Your parcel will arrive on Tuesday between 1pm and 5pm.",
  ...over,
});

function capture(reads: readonly ReadPromise[]) {
  return capturePromises({
    householdId: HH,
    messageId: "msg_900",
    merchant: "Northwind Parcel",
    receivedAt: AT,
    currency: "USD",
    reads,
    idGen: new SeededIdGen(),
  });
}

describe("how confident a read has to be before Owed tracks it", () => {
  it("tracks at the threshold and above, and not below", () => {
    expect(statusForConfidence(TRACKING_CONFIDENCE)).toBe("Captured");
    expect(statusForConfidence(1)).toBe("Captured");
    expect(statusForConfidence(TRACKING_CONFIDENCE - 0.01)).toBe("Candidate");
    expect(statusForConfidence(0)).toBe("Candidate");
  });

  /**
   * The threshold has to split real input or it is decoration.
   *
   * The rules extractor emits exactly three confidences — 0.95 where the cue sits next to
   * the time it qualifies, 0.82 where it is further away, 0.8 where a guarantee is
   * inferred rather than stated. If the threshold sat above or below all three, one of the
   * two statuses would be unreachable and nobody would know.
   */
  it("falls between the confidences the extractor actually emits", () => {
    expect(statusForConfidence(0.95)).toBe("Captured");
    expect(statusForConfidence(0.82)).toBe("Candidate");
    expect(statusForConfidence(0.8)).toBe("Candidate");
  });
});

describe("capturing what was read", () => {
  it("records one promise per read, each as its own event", () => {
    const { events, promises } = capture([read(), read({ kind: "guarantee", confidence: 0.8 })]);

    expect(events.map((event) => event.type)).toStrictEqual(["PromiseCaptured", "PromiseCaptured"]);
    expect(promises.map((promise) => promise.status)).toStrictEqual(["Captured", "Candidate"]);
  });

  /**
   * One message can carry both, which is the case worth having a test for: a merchant
   * writing "delivered between 1 and 5pm, guaranteed or your money back" states a delivery
   * window and implies a guarantee, and Owed should track the first and not the second.
   */
  it("keeps a strong and a weak read from the same message apart", () => {
    const { promises } = capture([
      read({ kind: "delivery_window", confidence: 0.95 }),
      read({ kind: "guarantee", confidence: 0.8 }),
    ]);

    expect(promises[0]?.kind).toBe("delivery_window");
    expect(promises[0]?.status).toBe("Captured");
    expect(promises[1]?.kind).toBe("guarantee");
    expect(promises[1]?.status).toBe("Candidate");
    // Same message, so the same source — the difference is the confidence, not the origin.
    expect(promises[0]?.source_ref).toBe(promises[1]?.source_ref);
  });

  /**
   * The extractor's guarantee is that nothing is read without the sentence it came from —
   * "a promise a household cannot trace back to a sentence somebody actually wrote them is
   * a promise Owed invented". That guarantee is worth nothing if this step drops it.
   */
  it("carries the sentence into the ledger", () => {
    const { promises } = capture([read({ evidence_text: "Arriving Tuesday between 1 and 5." })]);

    expect(promises[0]?.source_quote).toBe("Arriving Tuesday between 1 and 5.");
    expect(promises[0]?.source_ref).toBe("msg_900");
  });

  it("carries the timing and the money when there is any, and omits them when there is not", () => {
    const withAll = capture([
      read({
        window: { start: AT, end: "2026-10-11T08:15:00-07:00" },
        deadline: "2026-10-12T04:15:00-07:00",
        amount_at_stake: usd(54),
      }),
    ]).promises[0];
    const bare = capture([read()]).promises[0];

    expect(withAll?.window?.end).toBe("2026-10-11T08:15:00-07:00");
    expect(withAll?.deadline).toBe("2026-10-12T04:15:00-07:00");
    expect(withAll?.amount_at_stake).toStrictEqual(usd(54));
    expect(bare?.window).toBeUndefined();
    expect(bare?.deadline).toBeUndefined();
    expect(bare?.amount_at_stake).toBeUndefined();
  });

  it("is made at the moment the message arrived, not at some later now", () => {
    const { events, promises } = capture([read()]);

    expect(promises[0]?.made_at).toBe(AT);
    expect(events[0]?.occurred_at).toBe(AT);
  });

  /** Replaying the same message has to produce the same ledger, or a replay is not one. */
  it("gives the same ids for the same reads in the same order", () => {
    const first = capture([read(), read({ kind: "guarantee", confidence: 0.8 })]);
    const again = capture([read(), read({ kind: "guarantee", confidence: 0.8 })]);

    expect(again.promises.map((p) => p.id)).toStrictEqual(first.promises.map((p) => p.id));
    expect(again.events.map((e) => e.id)).toStrictEqual(first.events.map((e) => e.id));
  });

  it("projects to promises a household can see, with the status the read earned", () => {
    const { events } = capture([read(), read({ kind: "guarantee", confidence: 0.8 })]);
    const state = project(events.map((event, index) => ({ ...event, seq: index + 1 })));

    const statuses = [...state.promises.values()].map((view) => view.status);
    expect(statuses).toStrictEqual(["Captured", "Candidate"]);
    // Nothing is assessed yet: that is the breach engine's job, and it reasons about
    // evidence rather than about this status.
    expect([...state.promises.values()].every((view) => view.assessment === undefined)).toBe(true);
  });

  it("records nothing when a message promised nothing", () => {
    expect(capture([])).toStrictEqual({ events: [], promises: [] });
  });
});
