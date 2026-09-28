import {
  addMoney,
  type Breach,
  type Claim,
  type Currency,
  countRounds,
  type Evidence,
  type Instant,
  type LedgerSummaryItem,
  type LedgerTotals,
  type ObservationWindow,
  type OwedPromise,
  type PromiseStatus,
  type StoredLedgerEvent,
  toEpochMs,
  zeroMoney,
} from "@owed/domain";

export interface PromiseView {
  promise: OwedPromise;
  status: PromiseStatus;
  assessment?: Breach;
  assessed_at?: Instant;
  evidence: Evidence[];
  claim_id?: string;
}

export interface LedgerState {
  promises: Map<string, PromiseView>;
  claims: Map<string, Claim>;
  uptime: ObservationWindow[];
}

export function emptyLedgerState(): LedgerState {
  return { promises: new Map(), claims: new Map(), uptime: [] };
}

function setPromiseStatus(state: LedgerState, promiseId: string, status: PromiseStatus): void {
  const view = state.promises.get(promiseId);
  if (view) view.status = status;
}

function withClaim(state: LedgerState, claimId: string, mutate: (claim: Claim) => void): void {
  const claim = state.claims.get(claimId);
  if (claim) mutate(claim);
}

/** Fold one event into the state. Pure apart from mutating the accumulator it owns. */
export function apply(state: LedgerState, event: StoredLedgerEvent): LedgerState {
  switch (event.type) {
    case "PromiseCaptured":
      state.promises.set(event.promise.id, {
        promise: event.promise,
        status: event.promise.status,
        evidence: [],
      });
      break;

    case "EvidenceObserved": {
      const promiseId = event.evidence.promise_id;
      if (promiseId !== undefined) state.promises.get(promiseId)?.evidence.push(event.evidence);
      break;
    }

    case "SourceUptimeRecorded":
      state.uptime.push(event.window);
      break;

    case "PromiseAssessed": {
      const view = state.promises.get(event.assessment.promise_id);
      if (view) {
        view.assessment = event.assessment;
        view.assessed_at = event.occurred_at;
        if (event.assessment.verdict !== "Undetermined") view.status = event.assessment.verdict;
      }
      break;
    }

    case "ClaimProposed":
      state.claims.set(event.claim_id, {
        id: event.claim_id,
        promise_id: event.promise_id,
        household_id: event.household_id,
        merchant: event.merchant,
        state: "Proposed",
        ask: event.ask,
        rounds: [],
        route: event.route,
      });
      {
        const view = state.promises.get(event.promise_id);
        if (view) view.claim_id = event.claim_id;
      }
      break;

    case "ClaimFiled":
      withClaim(state, event.claim_id, (claim) => {
        claim.state = "Filed";
        claim.rounds.push({ type: "CLAIM", at: event.occurred_at, amount: claim.ask });
      });
      setPromiseStatus(state, event.promise_id, "Filed");
      break;

    case "OfferReceived":
      withClaim(state, event.claim_id, (claim) => {
        claim.state = "Negotiating";
        claim.rounds.push({
          type: "OFFER",
          at: event.occurred_at,
          amount: event.amount,
          form: event.form,
          ...(event.terms === undefined ? {} : { reason: event.terms }),
        });
        setPromiseStatus(state, claim.promise_id, "Negotiating");
      });
      break;

    case "CounterSent":
      withClaim(state, event.claim_id, (claim) => {
        claim.state = "Negotiating";
        claim.rounds.push({
          type: "COUNTER",
          at: event.occurred_at,
          amount: event.amount,
          justification: event.justification,
        });
      });
      break;

    case "Settled":
      withClaim(state, event.claim_id, (claim) => {
        claim.state = "Settled";
        claim.settled_amount = event.amount;
        claim.settled_at = event.occurred_at;
        claim.rounds.push({
          type: "SETTLE",
          at: event.occurred_at,
          amount: event.amount,
          form: event.form,
          ...(event.reference === undefined ? {} : { reference: event.reference }),
        });
        setPromiseStatus(state, claim.promise_id, "Settled");
      });
      break;

    case "Escalated":
      withClaim(state, event.claim_id, (claim) => {
        claim.state = "Escalated";
        claim.rounds.push({
          type: "DECLINE",
          at: event.occurred_at,
          reason: event.reason,
          escalation_route: event.escalation_route,
        });
        setPromiseStatus(state, claim.promise_id, "Escalated");
      });
      break;

    case "Recovered":
      withClaim(state, event.claim_id, (claim) => {
        claim.state = "Recovered";
        claim.recovered_amount = event.amount;
        claim.recovered_at = event.occurred_at;
        setPromiseStatus(state, claim.promise_id, "Recovered");
      });
      break;

    case "WrittenOff":
      withClaim(state, event.claim_id, (claim) => {
        claim.state = "WrittenOff";
        setPromiseStatus(state, claim.promise_id, "WrittenOff");
      });
      break;
  }
  return state;
}

export function project(events: readonly StoredLedgerEvent[]): LedgerState {
  return events.reduce(apply, emptyLedgerState());
}

/** States where money is committed but not yet in the household's hands. */
const OPEN_CLAIM_STATES = new Set(["Filed", "Negotiating", "Escalated", "Settled"]);

/**
 * Totals for a household.
 *
 * `since` bounds what counts as *recovered this week* and *kept this week*. Open money
 * is deliberately not bounded: it is a statement about the present, not the period.
 */
export function summarize(state: LedgerState, currency: Currency, since?: Instant): LedgerTotals {
  const withinPeriod = (instant: Instant | undefined): boolean =>
    since === undefined || (instant !== undefined && toEpochMs(instant) >= toEpochMs(since));

  let recovered = zeroMoney(currency);
  let open = zeroMoney(currency);

  for (const claim of state.claims.values()) {
    if (claim.state === "Recovered" && claim.recovered_amount) {
      if (withinPeriod(claim.recovered_at)) recovered = addMoney(recovered, claim.recovered_amount);
    } else if (OPEN_CLAIM_STATES.has(claim.state)) {
      open = addMoney(open, claim.settled_amount ?? claim.ask);
    }
  }

  const items: LedgerSummaryItem[] = [];
  let kept = 0;
  let declined = 0;

  for (const view of state.promises.values()) {
    if (view.status === "Kept" && withinPeriod(view.assessed_at)) kept += 1;
    if (view.status === "Suspected" && withinPeriod(view.assessed_at)) declined += 1;

    const claim = view.claim_id === undefined ? undefined : state.claims.get(view.claim_id);
    items.push({
      promise_id: view.promise.id,
      merchant: view.promise.merchant,
      kind: view.promise.kind,
      status: view.status,
      ...(claim
        ? {
            claim_id: claim.id,
            amount: claim.recovered_amount ?? claim.settled_amount ?? claim.ask,
          }
        : {}),
      ...(view.assessment ? { coverage: view.assessment.coverage } : {}),
    });
  }

  return { currency, recovered, open, kept, declined, items };
}

export function claimRoundCount(claim: Claim): number {
  return countRounds(claim.rounds);
}
