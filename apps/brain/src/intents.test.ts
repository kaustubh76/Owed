import type { Client } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import { OwedBrain } from "./brain.js";
import { INTENTS, routeUtterance } from "./intents.js";
import type { SessionHandle } from "./session.js";

/**
 * How the household's words become a tool call, which nothing tested.
 *
 * `routeUtterance` and the brain's focus slots are the whole of how anybody talks to Owed —
 * every chip in `VoiceBar.tsx` goes through here — and neither had a test. That mattered the
 * moment a third slot was added: `routeUtterance` searches the table **reversed**, so
 * inserting an intent changes which one wins for utterances that two patterns both match.
 */

describe("routing an utterance", () => {
  const cases: ReadonlyArray<[string, string]> = [
    ["Alexa, what am I owed?", "what_am_i_owed"],
    ["What came back this month?", "what_came_back_this_month"],
    ["What are you watching?", "list_promises"],
    ["Why aren't you claiming that?", "why_not_claiming"],
    ["Why aren't you watching that?", "why_not_watching"],
    ["File it", "file_it"],
  ];

  for (const [utterance, expected] of cases) {
    it(`sends "${utterance}" to ${expected}`, () => {
      expect(routeUtterance(utterance)?.name).toBe(expected);
    });
  }

  /**
   * The two refusals must not collide.
   *
   * "Not claiming" means Owed looked and saw too little; "not watching" means there is
   * nothing it could look at. They are different answers about different promises, and the
   * patterns are close enough that one swallowing the other would be invisible — the
   * household would simply get an answer about the wrong promise.
   */
  it("keeps the two refusals apart", () => {
    expect(routeUtterance("Why aren't you claiming that?")?.needsFocus).toBe("declined");
    expect(routeUtterance("Why aren't you watching that?")?.needsFocus).toBe("unwatched");
    expect(routeUtterance("not watching")?.name).toBe("why_not_watching");
    expect(routeUtterance("not claiming")?.name).toBe("why_not_claiming");
  });

  it("does not read a refusal as an instruction to file", () => {
    for (const utterance of ["Why aren't you claiming that?", "Why aren't you watching that?"]) {
      expect(routeUtterance(utterance)?.tool, utterance).toBe("promise_check");
    }
  });

  /**
   * The one that mattered: a question must never file a claim.
   *
   * `file_it` matches `claim it`, which is a substring of "do not claim it" and of "why
   * won't you claim it?" — so before `notWhen` existed, a household refusing had a claim
   * filed against a merchant with `confirm: true`, the flag that stands for their explicit
   * consent. `claim_file` is the only irreversible, outward-facing thing Owed does, and the
   * product's stated position is that nothing files without the household's yes.
   */
  describe("a question or a refusal never files", () => {
    const mustNotFile = [
      "Why did you not claim it?",
      "Why won't you claim it?",
      "Why aren't you going to claim it?",
      "Do not claim it",
      "Don't claim that",
      "Why would you claim it?",
      "Should I file it?",
      "Never file that",
      "No, do not file it",
    ];

    for (const utterance of mustNotFile) {
      it(`refuses to file on "${utterance}"`, () => {
        const intent = routeUtterance(utterance);
        expect(intent?.tool, `${utterance} reached claim_file`).not.toBe("claim_file");
      });
    }

    /** And the instructions still work, or the guard has eaten the feature. */
    for (const utterance of ["File it", "File that", "File this", "go ahead", "yes, file it"]) {
      it(`still files on "${utterance}"`, () => {
        expect(routeUtterance(utterance)).toMatchObject({
          tool: "claim_file",
          args: { confirm: true },
        });
      });
    }

    /**
     * The questions are answered rather than dropped where there is an intent for them,
     * because the guard skips the intent and keeps searching.
     */
    it("still answers the question it refused to act on", () => {
      expect(routeUtterance("Why won't you claim it?")?.name).toBe("why_not_claiming");
      expect(routeUtterance("Why did you not claim it?")?.tool).toBe("promise_check");
    });
  });

  it("says nothing it cannot route", () => {
    expect(routeUtterance("what is the weather")).toBeUndefined();
  });

  /** Every intent in the table is reachable, or it is dead weight in an ordered list. */
  it("can reach every intent it declares", () => {
    const reached = new Set(
      [
        "Alexa, what am I owed?",
        "What came back this month?",
        "What are you watching?",
        "Why did you not claim it?",
        "Why aren't you claiming that?",
        "Why aren't you watching that?",
        "File it",
      ].flatMap((utterance) => {
        const intent = routeUtterance(utterance);
        return intent === undefined ? [] : [intent.name];
      }),
    );
    expect([...reached].toSorted()).toStrictEqual(INTENTS.map((i) => i.name).toSorted());
  });
});

/** A session that answers with one canned tool result and records what it was asked. */
function fakeSession(result: unknown): { session: SessionHandle; calls: unknown[] } {
  const calls: unknown[] = [];
  const client = {
    callTool: (request: unknown) => {
      calls.push(request);
      return Promise.resolve(result);
    },
  } as unknown as Client;

  return {
    calls,
    session: {
      call: <T>(use: (c: Client) => Promise<T>) => use(client),
      ready: () => Promise.resolve(),
      invalidate: () => {},
      stop: () => {},
    },
  };
}

describe("which promise the brain has in mind", () => {
  const ledger = (items: unknown[]) => ({
    structuredContent: { items },
    content: [{ type: "text", text: "spoken" }],
  });

  it("asks about nothing until something puts a promise in mind", async () => {
    const { session, calls } = fakeSession(ledger([]));
    const brain = new OwedBrain(session);

    const turn = await brain.turn("Why aren't you watching that?");

    expect(calls, "no tool should be called with no subject").toStrictEqual([]);
    expect(turn.reply.length).toBeGreaterThan(0);
  });

  /**
   * The slot that did not exist, and the reason it had to.
   *
   * An unwatched promise's status is `Captured`, which is indistinguishable from one whose
   * moment of judgement has not come — so the brain reads `watched === false` off the ledger
   * item instead. Before this field existed on `LedgerSummaryItem` the state was unreachable
   * from the home at all.
   */
  it("takes an unwatched promise from the ledger it was just read", async () => {
    const { session, calls } = fakeSession(
      ledger([
        { promise_id: "prm_breached", status: "Breached" },
        { promise_id: "prm_warranty", status: "Captured", watched: false },
      ]),
    );
    const brain = new OwedBrain(session);

    await brain.turn("Alexa, what am I owed?");
    await brain.turn("Why aren't you watching that?");

    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({
      name: "promise_check",
      arguments: { promise_id: "prm_warranty" },
    });
  });

  /** And it must not steal the subject "file it" is about. */
  it("keeps the unwatched promise out of the filing slot", async () => {
    const { session, calls } = fakeSession(
      ledger([
        { promise_id: "prm_breached", status: "Breached" },
        { promise_id: "prm_warranty", status: "Captured", watched: false },
      ]),
    );
    const brain = new OwedBrain(session);

    await brain.turn("Alexa, what am I owed?");
    await brain.turn("File it");

    expect(calls[1]).toMatchObject({
      name: "claim_file",
      arguments: { promise_id: "prm_breached", confirm: true },
    });
  });

  /** A single card, rather than a list, puts its own promise in the right slot. */
  it("reads a single unwatched card into the unwatched slot", async () => {
    const { session, calls } = fakeSession({
      structuredContent: { promise_id: "prm_warranty", status: "Captured", watched: false },
      content: [{ type: "text", text: "spoken" }],
    });
    const brain = new OwedBrain(session);

    await brain.turn("What are you watching?");
    await brain.turn("Why aren't you watching that?");

    expect(calls[1]).toMatchObject({ arguments: { promise_id: "prm_warranty" } });
  });
});
