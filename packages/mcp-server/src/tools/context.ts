import { type LedgerState, project } from "@owed/core";
import type { Instant } from "@owed/domain";
import type { OwedDeps } from "../deps.js";
import { assertSpeakable } from "../voice.js";

/**
 * Everything the read tools need, loaded once per call.
 *
 * Every tool answers for the instant on the clock, so the timeline scrubber changes what
 * every tool says without any tool knowing the scrubber exists.
 */
export interface ToolContext {
  state: LedgerState;
  now: Instant;
}

export async function loadContext(deps: OwedDeps): Promise<ToolContext> {
  const now = deps.clock.now();
  return { state: project(await deps.store.read(deps.householdId, now)), now };
}

export class NotFoundError extends Error {}

export function requirePromise(context: ToolContext, promiseId: string) {
  const view = context.state.promises.get(promiseId);
  if (view === undefined) throw new NotFoundError(`No promise ${promiseId} in this ledger.`);
  return view;
}

export function requireClaim(context: ToolContext, claimId: string) {
  const claim = context.state.claims.get(claimId);
  if (claim === undefined) throw new NotFoundError(`No claim ${claimId} in this ledger.`);
  return claim;
}

/**
 * A tool result that says what went wrong, out loud, without leaking internals.
 *
 * `assertSpeakable` is applied here, which is what `voice.ts` already claimed: "this runs on
 * every tool result rather than only in tests". It did not — every `speak*` function on the
 * success path is guarded and this, the refusal path, was not, so a refusal was the one
 * spoken line that could carry a digit, a URL, a tool name or JSON to a voice-only device.
 * Most call sites pass a literal and were always fine; the ones that compose a sentence from
 * ledger state were a digit away from shipping one. A protocol violation from a merchant
 * agent did exactly that in October, reaching the household as raw exception text.
 *
 * It throws rather than substituting a safe line, which is the same bargain every success
 * path already takes: an unspeakable line is a bug, and a loud one is cheaper than a demo
 * that reads an identifier aloud on stage.
 */
export function spokenError(text: string) {
  return { content: [{ type: "text" as const, text: assertSpeakable(text) }], isError: true };
}
