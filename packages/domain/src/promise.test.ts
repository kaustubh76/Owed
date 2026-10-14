import { describe, expect, it } from "vitest";
import { isTerminalStatus, PromiseStatusSchema, TERMINAL_PROMISE_STATUSES } from "./promise.js";

/**
 * Which promise statuses mean the story is over.
 *
 * `TERMINAL_PROMISE_STATUSES` and `isTerminalStatus` had no caller and no test. They are
 * the promise-side analogue of `OPEN_CLAIM_STATES` in `core/src/ledger/projections.ts`,
 * which does the same job for claims — built for symmetry, and not yet needed, because the
 * ledger projection reasons about *specific* statuses (`Kept`, `Suspected`) and about claim
 * states rather than about terminality.
 *
 * So no call site is invented for them here. What is fixed is that they were a promise
 * nobody checked: the set could have drifted out of the status enum, or gained a member
 * that is plainly not an ending, and nothing would have failed.
 */
describe("whether a promise has reached its end", () => {
  it("counts the three endings and nothing else", () => {
    expect([...TERMINAL_PROMISE_STATUSES].sort()).toStrictEqual([
      "Kept",
      "Recovered",
      "WrittenOff",
    ]);
  });

  it("only names statuses the schema actually allows", () => {
    // A terminal status that is not a status at all would make `isTerminalStatus`
    // unreachable for it, silently.
    for (const status of TERMINAL_PROMISE_STATUSES) {
      expect(PromiseStatusSchema.safeParse(status).success, status).toBe(true);
    }
  });

  it("says yes for an ending and no for every status that is still in play", () => {
    for (const status of PromiseStatusSchema.options) {
      const terminal = TERMINAL_PROMISE_STATUSES.includes(status);
      expect(isTerminalStatus(status), status).toBe(terminal);
    }
  });

  it("treats the statuses a household is still waiting on as unfinished", () => {
    // Spelled out rather than derived, so that moving one of these into the terminal set
    // has to be a deliberate edit to this list and not a silent consequence.
    for (const status of [
      "Watching",
      "Breached",
      "Suspected",
      "Filed",
      "Negotiating",
      "Settled",
      "Escalated",
    ] as const) {
      expect(isTerminalStatus(status), status).toBe(false);
    }
  });

  it("does not treat Settled as an ending, because the money has not arrived", () => {
    // The distinction the ledger depends on: a merchant agreeing to pay is not the
    // household having been paid, and only `Recovered` means the credit was observed.
    expect(isTerminalStatus("Settled")).toBe(false);
    expect(isTerminalStatus("Recovered")).toBe(true);
  });
});
