import type { BreachKind, LedgerEvent, OwedPromise, PromiseKind } from "@owed/domain";
import { interval, usd } from "@owed/domain";
import { describe, expect, it } from "vitest";
import {
  meanRealisedWhenCountered,
  merchantPriors,
  priorKey,
  project,
} from "../ledger/projections.js";
import { MemoryEventStore } from "../ledger/store.js";
import { counteringHasPaid, MIN_OBSERVATIONS } from "./negotiator.js";

/**
 * What the ledger teaches the negotiator, and the join between them.
 *
 * `merchantPriors` and `counteringHasPaid` are the two halves of the result the README
 * leans on hardest — a 1.43x lift from per-merchant priors — and until now neither had a
 * single test in this package. The eval harness exercised its own local counter instead,
 * so the thing shipped to a household was tested nowhere and connected nowhere.
 *
 * These tests are about the projection and the decision. The wiring into `claim_file` is
 * asserted separately, by `packages/mcp-server/src/tools/claimFile.test.ts` and by the
 * browser gate, which both still see the cold path because the seeded week never reaches
 * `MIN_OBSERVATIONS`.
 */

const HH = "hh_learn";
const MERCHANT = "Stonewall Freight";

let counter = 0;
const envelope = (occurred_at: string) => {
  counter += 1;
  return { id: `evt_${counter}`, household_id: HH, occurred_at, recorded_at: occurred_at };
};

const at = (day: number, hhmm: string) =>
  `2026-10-${String(4 + day).padStart(2, "0")}T${hhmm}:00-07:00`;

function promise(id: string, kind: PromiseKind, day: number): OwedPromise {
  return {
    id,
    household_id: HH,
    merchant: MERCHANT,
    source_ref: `msg_${id}`,
    kind,
    made_at: at(day, "08:00"),
    currency: "USD",
    confidence: 0.95,
    status: "Watching",
  };
}

/**
 * One concluded claim where the household countered a standing offer.
 *
 * `offeredMajor` is what was on the table when they chose to argue; `settledMajor` is what
 * arguing actually realised. Making those two independent is the whole point: a prior is
 * only worth anything if it can record that countering *lost* money.
 */
function counteredClaim(
  id: string,
  kind: PromiseKind,
  breachKind: BreachKind,
  day: number,
  offeredMajor: number,
  settledMajor: number,
): LedgerEvent[] {
  const claimId = `clm_${id}`;
  const settled = usd(settledMajor);
  return [
    { ...envelope(at(day, "08:00")), type: "PromiseCaptured", promise: promise(id, kind, day) },
    {
      ...envelope(at(day, "17:00")),
      type: "PromiseAssessed",
      assessment: {
        id: `brc_${id}`,
        promise_id: id,
        kind: breachKind,
        verdict: "Breached",
        confidence: 0.91,
        coverage: 0.9,
        evaluation_interval: interval(at(day, "13:00"), at(day, "14:00")),
        observed: [interval(at(day, "13:00"), at(day, "13:54"))],
        evidence_ids: [`evd_${id}`],
        explanation: "scanned delivered, nobody came",
        detected_at: at(day, "17:00"),
      },
    },
    {
      ...envelope(at(day, "18:00")),
      type: "ClaimProposed",
      claim_id: claimId,
      promise_id: id,
      merchant: MERCHANT,
      ask: usd(20),
      expected: usd(10),
      route: "agent",
    },
    {
      ...envelope(at(day, "18:40")),
      type: "ClaimFiled",
      claim_id: claimId,
      promise_id: id,
      confirmed_by: "household",
      attached_evidence_ids: [],
    },
    {
      ...envelope(at(day, "18:41")),
      type: "OfferReceived",
      claim_id: claimId,
      amount: usd(offeredMajor),
      form: "credit",
    },
    {
      ...envelope(at(day, "18:42")),
      type: "CounterSent",
      claim_id: claimId,
      amount: usd(15),
      justification: { policy_clause: "Delivery Guarantee 4.2", evidence_ids: [`evd_${id}`] },
    },
    {
      ...envelope(at(day, "18:43")),
      type: "Settled",
      claim_id: claimId,
      amount: settled,
      form: "credit",
      rounds: 2,
    },
  ];
}

async function priorsFrom(events: LedgerEvent[]) {
  const store = new MemoryEventStore();
  await store.append(events);
  const state = project(await store.read(HH));
  return merchantPriors(state);
}

describe("what the ledger teaches about a merchant", () => {
  it("records a counter, what it gave up and what it realised", async () => {
    // Offered $8, argued, settled at $3. Arguing cost five dollars.
    const priors = await priorsFrom(
      counteredClaim("p1", "delivery_window", "phantom_delivery", 1, 8, 3),
    );
    const prior = priors.get(priorKey(MERCHANT, "phantom_delivery"));

    expect(prior?.countered).toBe(1);
    expect(prior?.countered_realised_minor).toBe(300);
    expect(prior?.countered_forgone_minor).toBe(800);
  });

  it("keys on the merchant and the breach kind together, not the merchant alone", async () => {
    const priors = await priorsFrom([
      ...counteredClaim("p1", "delivery_window", "phantom_delivery", 1, 8, 3),
      ...counteredClaim("p2", "eta", "late_eta", 2, 8, 3),
    ]);

    // Same merchant, two kinds. A carrier that stonewalls on deliveries may be reasonable
    // about arrival times, and collapsing the two would teach the wrong lesson about both.
    //
    // The key is the *breach* kind from the assessment, not the promise kind — which is
    // the right choice, because what the household is learning is how this merchant
    // argues about this sort of failure.
    expect(priors.size).toBe(2);
    expect(priors.get(priorKey(MERCHANT, "phantom_delivery"))?.countered).toBe(1);
    expect(priors.get(priorKey(MERCHANT, "late_eta"))?.countered).toBe(1);
    // Not `priorKey(MERCHANT, "eta")` — `eta` is the promise kind, `late_eta` the breach.
    expect(priors.get(priorKey(MERCHANT, "phantom_delivery"))?.breach_kind).toBe(
      "phantom_delivery",
    );
  });

  it("ignores a claim still being argued, rather than scoring it as a zero", async () => {
    // Everything up to the counter, and no settlement: the exchange is still open.
    const open = counteredClaim("p1", "delivery_window", "phantom_delivery", 1, 8, 3).slice(0, -1);
    const priors = await priorsFrom(open);

    expect(priors.size).toBe(0);
  });

  it("accumulates across encounters", async () => {
    const priors = await priorsFrom([
      ...counteredClaim("p1", "delivery_window", "phantom_delivery", 1, 8, 3),
      ...counteredClaim("p2", "delivery_window", "phantom_delivery", 2, 8, 3),
      ...counteredClaim("p3", "delivery_window", "phantom_delivery", 3, 8, 3),
    ]);
    const prior = priors.get(priorKey(MERCHANT, "phantom_delivery"));

    expect(prior?.countered).toBe(3);
    expect(prior?.countered_realised_minor).toBe(900);
  });
});

describe("whether arguing with this merchant has paid", () => {
  it("says nothing at all until it has seen enough", async () => {
    const priors = await priorsFrom([
      ...counteredClaim("p1", "delivery_window", "phantom_delivery", 1, 8, 3),
      ...counteredClaim("p2", "delivery_window", "phantom_delivery", 2, 8, 3),
    ]);
    const prior = priors.get(priorKey(MERCHANT, "phantom_delivery"));

    expect(prior?.countered).toBe(2);
    // Two losses is not a lesson. Undefined means "counter anyway" — you cannot learn
    // that a merchant punishes negotiation without negotiating with them.
    expect(counteringHasPaid(prior, 800)).toBeUndefined();
    expect(MIN_OBSERVATIONS).toBe(3);
  });

  it("says no once countering has reliably realised less than the offer on the table", async () => {
    const priors = await priorsFrom([
      ...counteredClaim("p1", "delivery_window", "phantom_delivery", 1, 8, 3),
      ...counteredClaim("p2", "delivery_window", "phantom_delivery", 2, 8, 3),
      ...counteredClaim("p3", "delivery_window", "phantom_delivery", 3, 8, 3),
    ]);
    const prior = priors.get(priorKey(MERCHANT, "phantom_delivery"));

    // Mean realised $3 against $8 standing: arguing has lost money three times running.
    expect(counteringHasPaid(prior, 800)).toBe(false);
  });

  it("says yes where countering has done better than the offer", async () => {
    const priors = await priorsFrom([
      ...counteredClaim("p1", "delivery_window", "phantom_delivery", 1, 5, 12),
      ...counteredClaim("p2", "delivery_window", "phantom_delivery", 2, 5, 12),
      ...counteredClaim("p3", "delivery_window", "phantom_delivery", 3, 5, 12),
    ]);
    const prior = priors.get(priorKey(MERCHANT, "phantom_delivery"));

    // Mean realised $12 against $5 standing: arguing is worth it here.
    expect(counteringHasPaid(prior, 500)).toBe(true);
  });

  it("is a comparison against the offer in front of it, not a verdict on the merchant", async () => {
    const priors = await priorsFrom([
      ...counteredClaim("p1", "delivery_window", "phantom_delivery", 1, 8, 6),
      ...counteredClaim("p2", "delivery_window", "phantom_delivery", 2, 8, 6),
      ...counteredClaim("p3", "delivery_window", "phantom_delivery", 3, 8, 6),
    ]);
    const prior = priors.get(priorKey(MERCHANT, "phantom_delivery"));

    // The same history, read against two different standing offers. Countering has
    // averaged $6: worth it against $5 on the table, not worth it against $8.
    expect(counteringHasPaid(prior, 500)).toBe(true);
    expect(counteringHasPaid(prior, 800)).toBe(false);
  });
});

describe("what countering has averaged", () => {
  /**
   * `meanRealisedWhenCountered` names the division `counteringHasPaid` performs inline,
   * and has no caller.
   *
   * It stays uncalled on purpose. Using it inside `counteringHasPaid` would make the
   * negotiation layer import the ledger layer, and `negotiator.ts:27-28` declares
   * `CounterExperience` structurally precisely so that it does not — the dependency would
   * run the wrong way for a package whose point is that the strategy does not know where
   * its history came from.
   *
   * So it is a ledger-side reporting helper: the figure you would show a household when
   * they ask why Owed stopped arguing with a merchant. Tested rather than wired, because
   * an untested helper is a promise nobody checked.
   */
  it("reports the mean a prior has realised by countering", async () => {
    const priors = await priorsFrom([
      ...counteredClaim("p1", "delivery_window", "phantom_delivery", 1, 8, 3),
      ...counteredClaim("p2", "delivery_window", "phantom_delivery", 2, 8, 6),
    ]);
    const prior = priors.get(priorKey(MERCHANT, "phantom_delivery"));

    // $3 and $6 over two counters.
    expect(meanRealisedWhenCountered(prior)).toBe(450);
  });

  it("says nothing where countering has never been tried, rather than dividing by zero", () => {
    expect(meanRealisedWhenCountered(undefined)).toBeUndefined();
    expect(
      meanRealisedWhenCountered({
        merchant: MERCHANT,
        breach_kind: "phantom_delivery",
        countered: 0,
        countered_realised_minor: 0,
        countered_forgone_minor: 0,
        accepted: 0,
        accepted_realised_minor: 0,
      }),
    ).toBeUndefined();
  });

  it("agrees with the comparison the negotiator makes from the same numbers", async () => {
    const priors = await priorsFrom([
      ...counteredClaim("p1", "delivery_window", "phantom_delivery", 1, 8, 3),
      ...counteredClaim("p2", "delivery_window", "phantom_delivery", 2, 8, 3),
      ...counteredClaim("p3", "delivery_window", "phantom_delivery", 3, 8, 3),
    ]);
    const prior = priors.get(priorKey(MERCHANT, "phantom_delivery"));
    const mean = meanRealisedWhenCountered(prior);
    if (mean === undefined) throw new Error("three counters should have a mean");

    // The two are separate implementations of the same division, in two layers that
    // deliberately do not import each other. This is what keeps them honest.
    expect(counteringHasPaid(prior, mean - 1)).toBe(true);
    expect(counteringHasPaid(prior, mean + 1)).toBe(false);
  });
});
