import type {
  Detection,
  Evidence,
  Instant,
  LedgerEvent,
  ObservationWindow,
  OwedPromise,
} from "@owed/domain";
import { assessPromise } from "../breach/engine.js";
import type { SiblingVerdict } from "../breach/types.js";
import type { IdGen } from "../time/determinism.js";

export interface AssessPromisesInput {
  householdId: string;
  /** The promises to judge. Order does not matter; derivation is resolved below. */
  promises: readonly OwedPromise[];
  evidence: readonly Evidence[];
  uptime: readonly ObservationWindow[];
  now: Instant;
  idGen: IdGen;
  /**
   * Verdicts the ledger already holds.
   *
   * Seeds the sibling pool so a derived promise can inherit from a sibling that was judged
   * in an earlier request. Without it, derivation would only ever work for promises assessed
   * together in one call, which is a coincidence of timing rather than a rule.
   */
  known?: readonly SiblingVerdict[];
}

export interface AssessPromisesResult {
  /** One `PromiseAssessed` per promise that reached a verdict. */
  events: LedgerEvent[];
  verdicts: SiblingVerdict[];
  /**
   * Promises no detector had anything to say about.
   *
   * Returned rather than thrown, because the two callers want opposite things from it. The
   * seeded week treats it as a bug and refuses to build — a storyboard promise nobody judges
   * is a hole in the demo. The live path treats it as a state: a promise can arrive before
   * its evidence does, and the household is told that in as many words rather than told
   * Owed is watching something it is not.
   */
  unassessed: OwedPromise[];
}

/**
 * Judge a household's promises, resolving derived ones against their siblings.
 *
 * **Why this exists.** `PromiseAssessed` was emitted in exactly one place —
 * `mcp-server/src/seed/build.ts` — so the breach engine ran when the seeded week was built
 * and never again. A promise captured at runtime through `POST /control/messages` was
 * written to the ledger and never judged, for any kind, because nothing assessed it. Seven
 * detectors, the coverage gate and the whole of H2 were reachable only from the seed
 * builder. Pulling the step in here gives both paths one implementation instead of a seeded
 * one and a live one that can drift apart while each looks right on its own.
 *
 * **Two passes, and why it is not a kind list.** `derivedBreach` needs its siblings' verdicts,
 * so something has to run first. Rather than hard-code which kinds derive — a second list to
 * keep in step with `appliesTo` — the first pass offers every promise no siblings at all and
 * the second pass retries only the ones that came back undefined, now with the first pass's
 * verdicts. A detector that needs context declares that by abstaining without it, which is
 * exactly what `derivedBreach` does, and a kind added later needs no change here.
 *
 * Ids come from `idGen` in a fixed order, so replaying the same inputs produces the same
 * ledger — the property the three store adapters are compared on.
 */
export function assessPromises(input: AssessPromisesInput): AssessPromisesResult {
  const { householdId, promises, evidence, uptime, now, idGen } = input;

  const judge = (promise: OwedPromise, siblings: readonly SiblingVerdict[]) =>
    assessPromise({
      promise,
      evidence,
      uptime,
      now,
      ...(siblings.length === 0 ? {} : { siblings }),
    });

  const verdicts: SiblingVerdict[] = [...(input.known ?? [])];
  const pending: OwedPromise[] = [];

  const judged: SiblingVerdict[] = [];
  for (const promise of promises) {
    const detection = judge(promise, []);
    if (detection === undefined) pending.push(promise);
    else {
      const entry = { promise, detection };
      verdicts.push(entry);
      judged.push(entry);
    }
  }

  const unassessed: OwedPromise[] = [];
  for (const promise of pending) {
    const detection = judge(promise, verdicts);
    if (detection === undefined) unassessed.push(promise);
    else {
      const entry = { promise, detection };
      verdicts.push(entry);
      judged.push(entry);
    }
  }

  // Emitted in the order the promises arrived, not the order they were judged, so a
  // derived verdict does not reorder the ledger relative to its inputs.
  const byId = new Map(judged.map((entry) => [entry.promise.id, entry.detection]));
  const events: LedgerEvent[] = [];
  for (const promise of promises) {
    const detection = byId.get(promise.id);
    if (detection === undefined) continue;
    events.push(assessedEvent({ householdId, detection, now, idGen }));
  }

  return { events, verdicts, unassessed };
}

/**
 * The `PromiseAssessed` event for one detection.
 *
 * Separate because `seed/build.ts` assesses promise by promise against the instant each arc
 * names, which is not one household-wide `now`.
 */
export function assessedEvent(input: {
  householdId: string;
  detection: Detection;
  now: Instant;
  idGen: IdGen;
}): LedgerEvent {
  return {
    id: input.idGen.next("evt"),
    household_id: input.householdId,
    occurred_at: input.now,
    recorded_at: input.now,
    type: "PromiseAssessed",
    assessment: { ...input.detection, id: input.idGen.next("brc"), detected_at: input.now },
  };
}
