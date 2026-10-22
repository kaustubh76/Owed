import type { CommitmentEvent } from "@owed/mcp-server";
import type { TurnMessage } from "./protocol.js";

/**
 * Which promises and claims a turn just touched, so Owed does not announce them back.
 *
 * `docs/proactive.md` opens on what this channel is *for*: "Owed exists to notice what the
 * household did **not** ask about." Filing a claim breaks that in the most direct way
 * available. `claim_file` settles, which makes a `claim_settled` commitment fall due, and
 * `main.ts` polls for commitments the instant a turn is broadcast — so the household says
 * "file it", hears *"Northwind Parcel settled at eight dollars. I will tell you when the
 * credit lands."*, and is then immediately told *"Northwind Parcel settled at eight dollars.
 * I will tell you when the credit lands."* by an interruption. The two lines are the same
 * sentence. Worse, the announcement carries a card, and the home keeps one turn, so the
 * claim card the household asked for is replaced by the announcement's.
 *
 * The poll still has to run — a turn is exactly when a new commitment appears — so what
 * changes is not whether it looks but whether it speaks. Events naming what the turn
 * touched are marked seen and stay quiet; anything else falls due on its own account and is
 * announced as it always was.
 */
export function subjectsOf(turn: TurnMessage): ReadonlySet<string> {
  const ids = new Set<string>();

  for (const step of turn.trace) add(step.args, ids);

  /**
   * The result as well as the arguments, and the result is the half that matters.
   *
   * "File it" calls `claim_file` with `{ promise_id }` alone — the claim id does not exist
   * yet. It is minted by the call and comes back in `structuredContent`, and it is the id
   * the `claim_settled` event names (`clm_prm_011` against an argument list that only ever
   * said `prm_011`). Reading the arguments alone would match the promise and miss the claim,
   * which is the one this exists to catch.
   */
  const result = turn.view?.result as { structuredContent?: unknown } | undefined;
  add(result?.structuredContent, ids);

  return ids;
}

/** The two id fields a commitment's subject can be matched on. */
const ID_KEYS = ["promise_id", "claim_id"] as const;

function add(source: unknown, into: Set<string>): void {
  if (typeof source !== "object" || source === null) return;
  const record = source as Record<string, unknown>;
  for (const key of ID_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value !== "") into.add(value);
  }
}

/**
 * Whether an announcement is about something the household has just been told.
 *
 * Matched on the subject rather than on timing: a commitment that happens to fall due in
 * the same instant for an unrelated promise is still news, and is still announced on the
 * next tick.
 */
export function justCaused(event: CommitmentEvent, subjects: ReadonlySet<string>): boolean {
  return ID_KEYS.some((key) => {
    const value = event.subject[key];
    return typeof value === "string" && subjects.has(value);
  });
}
