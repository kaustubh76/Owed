import { type LedgerState, project } from "@owed/core";
import type { Instant } from "@owed/domain";
import type { OwedDeps } from "../deps.js";

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

/** A tool result that says what went wrong, out loud, without leaking internals. */
export function spokenError(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}
