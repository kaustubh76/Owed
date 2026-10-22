import type { CommitmentEvent } from "@owed/mcp-server";
import { type Harness, startHarness } from "@owed/mcp-server";
import { describe, expect, it } from "vitest";
import { OwedBrain } from "./brain.js";
import { justCaused, subjectsOf } from "./proactive.js";
import { openSession, type SessionHandle } from "./session.js";

/**
 * The hero beat: what Owed says after the household answers an announcement.
 *
 * Both defects here were invisible to every existing test because they live in the *seam*
 * between a turn and the proactive channel, and nothing drove the two together. The
 * storyboard numbers were right throughout, which is exactly why the browser gate kept
 * passing while the beat was repeating itself and occasionally losing the card.
 */

/** Boots the real app and a real brain against it; generous because it is two processes' work. */
const TEST_TIMEOUT = 60_000;

async function brainAgainstOwed(): Promise<{
  harness: Harness;
  brain: OwedBrain;
  session: SessionHandle;
  commitments: () => Promise<CommitmentEvent[]>;
  close: () => Promise<void>;
}> {
  const harness = await startHarness();
  const token = await harness.link();
  const session = openSession({
    url: harness.mcpUrl,
    baseUrl: harness.baseUrl,
    clientId: "owed-simulated-home",
    staticToken: token,
    onFrame: () => {},
  });
  const brain = new OwedBrain(session);

  const commitments = async (): Promise<CommitmentEvent[]> => {
    const response = await fetch(new URL("/control/commitments", harness.baseUrl));
    const { events } = (await response.json()) as { events: CommitmentEvent[] };
    return events;
  };

  return {
    harness,
    brain,
    session,
    commitments,
    close: async () => {
      session.stop();
      await harness.close();
    },
  };
}

const breachWithOffer = (events: CommitmentEvent[]): CommitmentEvent => {
  const found = events.find((event) => event.kind === "promise_breached" && event.offer);
  if (found === undefined) throw new Error("the storyboard has no breach to answer");
  return found;
};

describe("Owed does not announce what the household just asked for", () => {
  it("marks the commitment its own turn created, so it is never spoken back", {
    timeout: TEST_TIMEOUT,
  }, async () => {
    const owed = await brainAgainstOwed();
    try {
      const before = await owed.commitments();
      await owed.brain.turn("what am I owed");
      const filed = await owed.brain.turn("file it");

      const after = await owed.commitments();
      const appeared = after.filter(
        (event) => !before.some((old) => old.event_id === event.event_id),
      );

      // Filing is what creates it, and this is the sentence the household has just heard.
      expect(appeared.map((event) => event.kind)).toStrictEqual(["claim_settled"]);
      const settled = appeared[0] as CommitmentEvent;
      expect(settled.spoken).toContain("settled at eight dollars");
      expect(filed.reply).toContain("settled at eight dollars");

      const subjects = subjectsOf(filed);

      /**
       * The claim id, which exists nowhere in the arguments.
       *
       * "File it" calls `claim_file` with `{ promise_id, confirm }`; the claim is minted by
       * the call. The event names that minted id, so matching on arguments alone would miss
       * the very event this suppresses.
       */
      expect(settled.subject.claim_id).toBeDefined();
      expect(subjects, "the minted claim id").toContain(settled.subject.claim_id);
      expect(subjects, "the promise that was asked about").toContain(settled.subject.promise_id);

      expect(justCaused(settled, subjects), "suppressed as the household's own doing").toBe(true);

      /**
       * And nothing else goes quiet with it.
       *
       * The storyboard carries two recovered claims that have nothing to do with this turn.
       * Suppressing by *timing* would have swallowed them; suppressing by subject does not.
       */
      const unrelated = after.filter((event) => event.event_id !== settled.event_id);
      expect(unrelated.length, "other commitments in the week").toBeGreaterThan(0);
      for (const event of unrelated) {
        expect(justCaused(event, subjects), `${event.event_id} is still news`).toBe(false);
      }
    } finally {
      await owed.close();
    }
  });
});

describe("answering an announcement's offer", () => {
  it("calls the tool and arguments the offer names, and they file rather than ask again", {
    timeout: TEST_TIMEOUT,
  }, async () => {
    const owed = await brainAgainstOwed();
    try {
      const breach = breachWithOffer(await owed.commitments());
      const offer = breach.offer as {
        utterance: string;
        tool: string;
        arguments: Record<string, unknown>;
      };

      const answered = await owed.brain.answerOffer(offer);

      expect(answered.trace.map((step) => step.tool)).toStrictEqual(["claim_file"]);
      expect(answered.trace[0]?.args.promise_id, "the promise the offer named").toBe(
        breach.subject.promise_id,
      );
      expect(answered.trace[0]?.isError).toBe(false);

      /**
       * `confirm`, which the offer did not carry until this test existed.
       *
       * The announcement's own spoken line ends "Shall I file it?", so a press is the answer
       * to that question and the arguments have to be the ones that file. Without `confirm`
       * they are the ones that *propose* — so a host following the published offer would ask
       * a second time about a claim the household had just agreed to. Nobody noticed because
       * the only consumer of `offer.arguments` was a tooltip.
       */
      expect(answered.trace[0]?.args.confirm).toBe(true);
      expect(answered.reply).toContain("settled");
      const structured = (answered.view?.result as { structuredContent?: { state?: string } })
        ?.structuredContent;
      expect(structured?.state, "the offer performed what it offered").toBe("Settled");
    } finally {
      await owed.close();
    }
  });

  /**
   * The press knows its own subject; the words have to be given one.
   *
   * This is the whole reason `offer` exists — `docs/proactive.md` calls it the field without
   * which "somebody hears that something is wrong and has to work out for themselves how to
   * ask for it to be fixed". Sending `offer.utterance` instead of `offer.tool` put the press
   * back on that footing: it only worked while something else had already established focus.
   *
   * Note what this does *not* claim. `#rememberFocus` ignores a claim card (it requires a
   * `status`, and a claim view carries a `state`), so a recovered-claim announcement cannot
   * steal focus — `scripts/verify-ui.mjs` says it can, and that comment is wrong. The real
   * difference is the one below: no focus, no answer.
   */
  it("works with no focus at all, where the words have nothing to resolve against", {
    timeout: TEST_TIMEOUT,
  }, async () => {
    const owed = await brainAgainstOwed();
    try {
      const breach = breachWithOffer(await owed.commitments());
      const offer = breach.offer as {
        utterance: string;
        tool: string;
        arguments: Record<string, unknown>;
      };

      // A brain that has not spoken yet: exactly what "File it" used to be sent into.
      expect(owed.brain.focus).toBeUndefined();
      const spoken = await owed.brain.turn(offer.utterance);
      expect(spoken.trace, "the words had nothing to resolve against").toStrictEqual([]);
      expect(spoken.reply).toContain("Tell me which promise you mean");

      const answered = await owed.brain.answerOffer(offer);
      expect(answered.trace[0]?.args.promise_id).toBe(breach.subject.promise_id);
      expect(answered.reply).toContain("settled");
    } finally {
      await owed.close();
    }
  });

  it("refuses a tool the server does not advertise", { timeout: TEST_TIMEOUT }, async () => {
    const owed = await brainAgainstOwed();
    try {
      const answered = await owed.brain.answerOffer({
        utterance: "Do the thing",
        tool: "drop_the_ledger",
        arguments: {},
      });
      expect(answered.trace, "nothing was called").toStrictEqual([]);
      expect(answered.reply).toContain("I can tell you what you're owed");
    } finally {
      await owed.close();
    }
  });
});

/** The `_meta.ui.resourceUri` a tool result carries, read straight rather than through the brain. */
function viewTheToolSupplied(result: unknown): string | undefined {
  const meta = (result as { _meta?: { ui?: { resourceUri?: unknown } } } | undefined)?._meta;
  const uri = meta?.ui?.resourceUri;
  return typeof uri === "string" ? uri : undefined;
}

describe("the card an announcement declares", () => {
  /**
   * Two declarations of "which card for this event", in two packages.
   *
   * `proactive/scheduler.ts` puts a `resource_uri` on every event it builds, and the tool that
   * supplies the data carries its own `_meta.ui.resourceUri`. Nothing compared them. They agreed
   * because both were written to agree, which is the state `schemas.sync.test.ts` exists to
   * refuse everywhere else in this repository — and here one half was read by nothing at all.
   *
   * Read off the tool result directly rather than through the brain's own reader, so this
   * compares the *server's* two statements instead of comparing the brain to itself.
   */
  it("is the card the tool that fills it agrees to, for every kind the week produces", {
    timeout: TEST_TIMEOUT,
  }, async () => {
    const owed = await brainAgainstOwed();
    try {
      const before = await owed.commitments();
      await owed.brain.turn("what am I owed");
      await owed.brain.turn("file it");
      const after = await owed.commitments();

      // Every kind, and the settled one only exists because the claim above was filed.
      const events = [...before, ...after].filter(
        (event, index, all) =>
          all.findIndex((other) => other.event_id === event.event_id) === index,
      );
      const kinds = new Set(events.map((event) => event.kind));
      expect(kinds, "all three kinds reached").toStrictEqual(
        new Set(["promise_breached", "claim_recovered", "claim_settled"]),
      );

      for (const event of events) {
        expect(event.resource_uri, `${event.event_id} declares a card`).toBeDefined();
        const announced = await owed.brain.announce(event);

        expect(announced.view?.uri, `${event.event_id} rendered the card it declared`).toBe(
          event.resource_uri,
        );
        expect(
          viewTheToolSupplied(announced.view?.result),
          `${event.event_id}: the tool's own view`,
        ).toBe(event.resource_uri);
      }
    } finally {
      await owed.close();
    }
  });

  /**
   * "Absent is legitimate: voice is enough" — the schema's own words.
   *
   * The old path read the uri off the tool result, so an event that declared no card got one
   * anyway. Unreachable through `scheduler.ts`, which sets it on all three kinds; reachable the
   * moment anything else produces one of these, which is the point of publishing a schema.
   */
  it("is nothing at all when the event declares none, and the announcement still speaks", {
    timeout: TEST_TIMEOUT,
  }, async () => {
    const owed = await brainAgainstOwed();
    try {
      const breach = breachWithOffer(await owed.commitments());
      const { resource_uri: _declared, ...voiceOnly } = breach;

      const announced = await owed.brain.announce(voiceOnly);

      // `.uri`, not the whole payload: a view carries ~460 KB of inlined HTML, and asserting
      // on the object dumps all of it into the diff. Found by watching this very assertion
      // fail under mutation and print 96 KB of bundled React.
      expect(announced.view?.uri, "no card was drawn").toBeUndefined();
      expect(announced.reply, "and it still said it out loud").toBe(breach.spoken);
      // The tool still ran, which is what makes "file it" work on a device with no screen.
      expect(owed.brain.focus, "focus was still left on the promise").toBe(
        breach.subject.promise_id,
      );
    } finally {
      await owed.close();
    }
  });
});
