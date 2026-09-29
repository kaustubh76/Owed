import {
  addMoney,
  type Breach,
  type BreachKind,
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
        expected: event.expected,
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
        claim.rounds.push({
          seq: claim.rounds.length,
          type: "CLAIM",
          at: event.occurred_at,
          amount: claim.ask,
        });
      });
      setPromiseStatus(state, event.promise_id, "Filed");
      break;

    case "OfferReceived":
      withClaim(state, event.claim_id, (claim) => {
        claim.state = "Negotiating";
        claim.rounds.push({
          seq: claim.rounds.length,
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
          seq: claim.rounds.length,
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
        claim.round_count = event.rounds;
        claim.rounds.push({
          seq: claim.rounds.length,
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
          seq: claim.rounds.length,
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
      open = addMoney(open, claim.settled_amount ?? claim.expected);
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

/**
 * How many rounds the claim took.
 *
 * Prefers what the session recorded. Recounting from the transcript cannot distinguish
 * a merchant's own settlement from the one written down when the household accepted an
 * offer, and would report an extra round for every claim that settled on first contact.
 */
export function claimRoundCount(claim: Claim): number {
  return claim.round_count ?? countRounds(claim.rounds);
}

// ---------------------------------------------------------------------------
// Merchant priors
// ---------------------------------------------------------------------------

/**
 * What this household has learned about arguing with one merchant about one kind of
 * broken promise.
 *
 * A projection of events already recorded, not a new store: every claim's transcript and
 * outcome is in the ledger, so the feedback loop costs nothing to persist and everything
 * feeding a decision stays inspectable.
 */
export interface MerchantPrior {
  merchant: string;
  breach_kind: BreachKind;
  /** Times a lowball was countered. */
  countered: number;
  /** What those counters actually realised, in minor units. */
  countered_realised_minor: number;
  /** What was on the table at the moment of countering, and therefore given up to try. */
  countered_forgone_minor: number;
  /** Times an offer was taken as it stood. */
  accepted: number;
  accepted_realised_minor: number;
}

export type PriorTable = ReadonlyMap<string, MerchantPrior>;

export function priorKey(merchant: string, breachKind: BreachKind): string {
  return `${merchant}::${breachKind}`;
}

/** Mean realised when countering, or `undefined` when it has never been tried. */
export function meanRealisedWhenCountered(prior: MerchantPrior | undefined): number | undefined {
  if (prior === undefined || prior.countered === 0) return undefined;
  return prior.countered_realised_minor / prior.countered;
}

function emptyPrior(merchant: string, breach_kind: BreachKind): MerchantPrior {
  return {
    merchant,
    breach_kind,
    countered: 0,
    countered_realised_minor: 0,
    countered_forgone_minor: 0,
    accepted: 0,
    accepted_realised_minor: 0,
  };
}

/** Fold one finished claim into a table of priors. */
export function recordOutcome(
  table: Map<string, MerchantPrior>,
  outcome: {
    merchant: string;
    breach_kind: BreachKind;
    countered: boolean;
    /** What was on the table when the decision was taken. */
    standing_minor: number;
    realised_minor: number;
  },
): void {
  const key = priorKey(outcome.merchant, outcome.breach_kind);
  const prior = table.get(key) ?? emptyPrior(outcome.merchant, outcome.breach_kind);

  if (outcome.countered) {
    prior.countered += 1;
    prior.countered_realised_minor += outcome.realised_minor;
    prior.countered_forgone_minor += outcome.standing_minor;
  } else {
    prior.accepted += 1;
    prior.accepted_realised_minor += outcome.realised_minor;
  }

  table.set(key, prior);
}

/**
 * Derive priors from the ledger.
 *
 * Only concluded claims count. A claim still being argued has not taught anything yet,
 * and treating an open claim as a zero would make every merchant look hopeless.
 */
export function merchantPriors(state: LedgerState): PriorTable {
  const table = new Map<string, MerchantPrior>();

  for (const claim of state.claims.values()) {
    if (claim.state !== "Settled" && claim.state !== "Recovered" && claim.state !== "Escalated") {
      continue;
    }

    const breachKind = state.promises.get(claim.promise_id)?.assessment?.kind;
    if (breachKind === undefined) continue;

    const counterIndex = claim.rounds.findIndex((round) => round.type === "COUNTER");
    const countered = counterIndex !== -1;
    const standingBefore = claim.rounds
      .slice(0, countered ? counterIndex : claim.rounds.length)
      .filter((round) => round.type === "OFFER")
      .at(-1);

    recordOutcome(table, {
      merchant: claim.merchant,
      breach_kind: breachKind,
      countered,
      standing_minor: standingBefore?.amount?.minor ?? 0,
      realised_minor: claim.settled_amount?.minor ?? 0,
    });
  }

  return table;
}
