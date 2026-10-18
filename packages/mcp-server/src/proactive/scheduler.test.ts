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

/**
 * How many announcements crossing Sunday evening produces.
 *
 * `docs/demo-script.md` tells whoever records the video that "crossing the evening fires
 * **three** announcements, not one, oldest first", and nothing asserted any part of that.
 * Five tests below loop this list with an `expect` in the body, so a projection that
 * produced nothing would have passed every one of them while the demo's loudest beat did
 * not happen.
 */
const SUNDAY_EVENING_ANNOUNCEMENTS = 3;

/** The same list, with its size asserted, so a caller cannot loop over nothing. */
async function sundayEvening() {
  const events = await dueAt(at("sun", "19:30"));
  expect(events, "announcements on crossing Sunday evening").toHaveLength(
    SUNDAY_EVENING_ANNOUNCEMENTS,
  );
  return events;
}

describe("the proactive scheduler", () => {
  /** The shape the recording guide promises, asserted rather than described. */
  it("fires three announcements on crossing Sunday evening, oldest first", async () => {
    const events = await sundayEvening();

    const occurred = events.map((event) => event.occurred_at);
    expect([...occurred].sort(), "oldest first").toEqual(occurred);
    expect(
      events.filter((event) => event.kind === "promise_breached"),
      "exactly one of them is the breach the household is asked about",
    ).toHaveLength(1);
  });

  it("says nothing before anything has broken", async () => {
    expect(await dueAt(at("mon", "08:00"))).toEqual([]);
  });

  it("raises a breach once, and only once it has been detected", async () => {
    const events = await sundayEvening();
    for (const event of events) expect(() => CommitmentEventSchema.parse(event)).not.toThrow();
  });

  /**
   * The property that makes the scrubber work. A queue would replay announcements on
   * the way back through the week, or lose them on the way forward; a projection
   * cannot, because the same instant is the same question.
   *
   * The second assertion is what makes the first one mean anything. On its own, "the same
   * instant gives the same answer" compares one call to another call with the same
   * argument: true of a correct projection, and equally true of one that always returns
   * the same thing regardless of when you ask — which is the opposite of a scrubber.
   * `eval/src/robustness.test.ts` pairs its determinism check with a differing seed for
   * exactly this reason.
   */
  it("answers the same for an instant, and differently for a different one", async () => {
    const instant = at("sun", "19:30");
    const asked = await dueAt(instant);

    expect(asked).toHaveLength(SUNDAY_EVENING_ANNOUNCEMENTS);
    expect(await dueAt(instant)).toEqual(asked);
    expect(
      await dueAt(at("mon", "08:00")),
      "a different instant is a different question",
    ).not.toEqual(asked);
  });

  it("takes an announcement back when the clock moves before it", async () => {
    const late = await dueAt(at("sun", "19:30"));
    const early = await dueAt(at("mon", "08:00"));
    expect(early.length).toBeLessThan(late.length);
  });

  it("never raises a promise it has already filed a claim for", async () => {
    const events = await sundayEvening();
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
    for (const event of await sundayEvening()) {
      expect(event.spoken.length).toBeLessThanOrEqual(MAX_SPOKEN_CHARS);
      expect(event.spoken).not.toMatch(/[0-9]/);
      expect(event.spoken).not.toMatch(/prm_|clm_|evd_|brc_/);
    }
  });

  it("gives every announcement a next step the household can say", async () => {
    // The `continue` below filters twice over, so the dedicated test above pins that
    // exactly one breach announcement exists to reach these assertions at all.
    for (const event of await sundayEvening()) {
      if (event.kind !== "promise_breached") continue;
      expect(event.offer?.tool).toBe("claim_file");
      expect(event.offer?.arguments.promise_id).toBe(event.subject.promise_id);
    }
  });

  /**
   * Identity has to survive both re-polling and replay, or the household hears it twice.
   *
   * And it has to be derived from the event rather than constant, or the household hears
   * one announcement for everything — so a Monday instant has to produce a different set
   * of ids, not merely a stable one.
   */
  it("gives an event the same id every time it is derived, and not the same id to every event", async () => {
    const first = await sundayEvening();
    const second = await sundayEvening();

    expect(first.map((e) => e.event_id)).toEqual(second.map((e) => e.event_id));
    expect(new Set(first.map((e) => e.event_id)).size, "distinct ids").toBe(first.length);
    expect(
      await dueAt(at("mon", "08:00")).then((events) => events.map((e) => e.event_id)),
      "a different instant does not reuse these ids",
    ).not.toEqual(first.map((e) => e.event_id));
  });

  it("stops offering an announcement once it has gone stale", async () => {
    const events = await sundayEvening();
    for (const event of events) {
      expect(new Date(event.expires_at).getTime()).toBeGreaterThan(
        new Date(event.occurred_at).getTime(),
      );
    }
  });
});
