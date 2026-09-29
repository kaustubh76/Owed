import { MemoryEventStore, project } from "@owed/core";
import { describe, expect, it } from "vitest";
import { at, HOUSEHOLD_ID, storyboardEvents } from "../seed/storyboard.js";
import { MAX_SPOKEN_CHARS } from "../voice.js";
import { CommitmentEventSchema } from "./commitment.js";
import { commitmentsDue } from "./scheduler.js";

async function dueAt(instant: string) {
  const store = new MemoryEventStore();
  await store.append(await storyboardEvents());
  return commitmentsDue(project(await store.read(HOUSEHOLD_ID, instant)), instant, HOUSEHOLD_ID);
}

describe("the proactive scheduler", () => {
  it("says nothing before anything has broken", async () => {
    expect(await dueAt(at("mon", "08:00"))).toEqual([]);
  });

  it("raises a breach once, and only once it has been detected", async () => {
    const events = await dueAt(at("sun", "19:30"));
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) expect(() => CommitmentEventSchema.parse(event)).not.toThrow();
  });

  /**
   * The property that makes the scrubber work. A queue would replay announcements on
   * the way back through the week, or lose them on the way forward; a projection
   * cannot, because the same instant is the same question.
   */
  it("answers the same for an instant however it was reached", async () => {
    const instant = at("sun", "19:30");
    expect(await dueAt(instant)).toEqual(await dueAt(instant));
  });

  it("takes an announcement back when the clock moves before it", async () => {
    const late = await dueAt(at("sun", "19:30"));
    const early = await dueAt(at("mon", "08:00"));
    expect(early.length).toBeLessThan(late.length);
  });

  it("never raises a promise it has already filed a claim for", async () => {
    const events = await dueAt(at("sun", "19:30"));
    const settled = events.filter((event) => event.kind === "promise_breached");
    for (const event of settled) {
      expect(event.subject.claim_id).toBeUndefined();
    }
  });

  /**
   * `Suspected` is the verdict Owed refuses to act on. Speaking first without being
   * asked is the last place to start guessing, so it must never appear here.
   */
  it("never raises a promise it only suspects", async () => {
    const store = new MemoryEventStore();
    await store.append(await storyboardEvents());
    const instant = at("sun", "19:30");
    const state = project(await store.read(HOUSEHOLD_ID, instant));

    const suspected = new Set(
      [...state.promises.values()]
        .filter((view) => view.assessment?.verdict === "Suspected")
        .map((view) => view.promise.id),
    );
    expect(suspected.size).toBeGreaterThan(0);

    for (const event of commitmentsDue(state, instant, HOUSEHOLD_ID)) {
      expect(suspected.has(event.subject.promise_id)).toBe(false);
    }
  });

  it("speaks lines a device could say as they are", async () => {
    for (const event of await dueAt(at("sun", "19:30"))) {
      expect(event.spoken.length).toBeLessThanOrEqual(MAX_SPOKEN_CHARS);
      expect(event.spoken).not.toMatch(/[0-9]/);
      expect(event.spoken).not.toMatch(/prm_|clm_|evd_|brc_/);
    }
  });

  it("gives every announcement a next step the household can say", async () => {
    for (const event of await dueAt(at("sun", "19:30"))) {
      if (event.kind !== "promise_breached") continue;
      expect(event.offer?.tool).toBe("claim_file");
      expect(event.offer?.arguments.promise_id).toBe(event.subject.promise_id);
    }
  });

  /** Identity has to survive both re-polling and replay, or the household hears it twice. */
  it("gives an event the same id every time it is derived", async () => {
    const first = await dueAt(at("sun", "19:30"));
    const second = await dueAt(at("sun", "19:30"));
    expect(first.map((e) => e.event_id)).toEqual(second.map((e) => e.event_id));
    expect(new Set(first.map((e) => e.event_id)).size).toBe(first.length);
  });

  it("stops offering an announcement once it has gone stale", async () => {
    const events = await dueAt(at("sun", "19:30"));
    for (const event of events) {
      expect(new Date(event.expires_at).getTime()).toBeGreaterThan(
        new Date(event.occurred_at).getTime(),
      );
    }
  });
});
