import type { LedgerEvent, OwedPromise, PromiseKind } from "@owed/domain";
import { interval, usd } from "@owed/domain";
import { beforeEach, describe, expect, it } from "vitest";
import { claimRoundCount, project, summarize } from "./projections.js";
import { MemoryEventStore } from "./store.js";

const HH = "hh_demo";
const at = (day: number, hhmm: string) =>
  `2026-10-${String(4 + day).padStart(2, "0")}T${hhmm}:00-07:00`;

let counter = 0;
const envelope = (occurred_at: string) => {
  counter += 1;
  return { id: `evt_${counter}`, household_id: HH, occurred_at, recorded_at: occurred_at };
};

function promise(id: string, merchant: string, kind: PromiseKind, day: number): OwedPromise {
  return {
    id,
    household_id: HH,
    merchant,
    source_ref: `msg_${id}`,
    kind,
    made_at: at(day, "08:00"),
    currency: "USD",
    confidence: 0.95,
    status: "Watching",
  };
}

/** A promise that breaches, is claimed, settles and is then observed as recovered. */
function recoveredChain(
  id: string,
  merchant: string,
  kind: PromiseKind,
  day: number,
  amountMajor: number,
): LedgerEvent[] {
  const claimId = `clm_${id}`;
  const amount = usd(amountMajor);
  return [
    {
      ...envelope(at(day, "08:00")),
      type: "PromiseCaptured",
      promise: promise(id, merchant, kind, day),
    },
    {
      ...envelope(at(day, "17:00")),
      type: "PromiseAssessed",
      assessment: {
        id: `brc_${id}`,
        promise_id: id,
        kind: kind === "delivery_window" ? "phantom_delivery" : "late_eta",
        verdict: "Breached",
        confidence: 0.91,
        coverage: 0.82,
        evaluation_interval: interval(at(day, "13:42"), at(day, "14:42")),
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
      merchant,
      ask: usd(15),
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
      amount: usd(5),
      form: "credit",
    },
    {
      ...envelope(at(day, "18:42")),
      type: "CounterSent",
      claim_id: claimId,
      amount,
      justification: { policy_clause: "Delivery Guarantee 4.2", evidence_ids: [`evd_${id}`] },
    },
    {
      ...envelope(at(day, "18:43")),
      type: "Settled",
      claim_id: claimId,
      amount,
      form: "credit",
      rounds: 2,
    },
    {
      ...envelope(at(day + 1, "10:05")),
      type: "Recovered",
      claim_id: claimId,
      amount,
      evidence_id: `evd_credit_${id}`,
    },
  ];
}

function keptPromise(id: string, merchant: string, day: number): LedgerEvent[] {
  return [
    {
      ...envelope(at(day, "08:00")),
      type: "PromiseCaptured",
      promise: promise(id, merchant, "delivery_window", day),
    },
    {
      ...envelope(at(day, "16:00")),
      type: "PromiseAssessed",
      assessment: {
        id: `brc_${id}`,
        promise_id: id,
        kind: "missed_window",
        verdict: "Kept",
        confidence: 0.99,
        coverage: 1,
        evaluation_interval: interval(at(day, "12:00"), at(day, "16:00")),
        evidence_ids: [],
        explanation: "delivered inside the window",
        detected_at: at(day, "16:00"),
      },
    },
  ];
}

/** Coverage below the gate: Owed states what it saw instead of claiming. */
function suspectedPromise(id: string, merchant: string, day: number): LedgerEvent[] {
  return [
    {
      ...envelope(at(day, "08:00")),
      type: "PromiseCaptured",
      promise: promise(id, merchant, "delivery_window", day),
    },
    {
      ...envelope(at(day, "17:10")),
      type: "PromiseAssessed",
      assessment: {
        id: `brc_${id}`,
        promise_id: id,
        kind: "phantom_delivery",
        verdict: "Suspected",
        confidence: 0.88,
        coverage: 0.2,
        evaluation_interval: interval(at(day, "16:10"), at(day, "17:10")),
        evidence_ids: [],
        explanation: "only 20% of the window was watched",
        detected_at: at(day, "17:10"),
      },
    },
  ];
}

async function projectAll(events: LedgerEvent[], upTo?: string) {
  const store = new MemoryEventStore();
  await store.append(events);
  return project(await store.read(HH, upTo));
}

describe("ledger projection", () => {
  beforeEach(() => {
    counter = 0;
  });

  it("reproduces the storyboard's weekly headline", async () => {
    const events: LedgerEvent[] = [
      ...recoveredChain("prm_1", "Meridian Rides", "eta", 0, 3),
      ...recoveredChain("prm_2", "Northwind Parcel", "delivery_window", 1, 12),
      ...recoveredChain("prm_3", "Alder Home Services", "appointment_slot", 2, 9),
      ...recoveredChain("prm_5", "Calder & Co.", "price_match", 4, 15),
      ...recoveredChain("prm_6", "Northwind Parcel", "delivery_window", 5, 8),
      ...keptPromise("prm_8", "Northwind Parcel", 3),
      ...keptPromise("prm_9", "Alder Home Services", 4),
      ...suspectedPromise("prm_10", "Northwind Parcel", 6),
    ];

    const summary = summarize(await projectAll(events), "USD");

    expect(summary.recovered).toEqual(usd(47));
    expect(summary.kept).toBe(2);
    expect(summary.declined).toBe(1);
    expect(summary.open).toEqual(usd(0));
  });

  it("counts a settled-but-not-yet-observed claim as open, not recovered", async () => {
    const events = recoveredChain("prm_x", "Northwind Parcel", "delivery_window", 1, 12);
    const beforeCredit = events.slice(0, -1);

    const summary = summarize(await projectAll(beforeCredit), "USD");

    expect(summary.open).toEqual(usd(12));
    expect(summary.recovered).toEqual(usd(0));
  });

  it("counts an escalated claim as open at the ask", async () => {
    const [captured, assessed, proposed, filed] = recoveredChain(
      "prm_e",
      "Calder & Co.",
      "refund_sla",
      3,
      5,
    );
    const events = [captured, assessed, proposed, filed].filter(
      (e): e is LedgerEvent => e !== undefined,
    );
    events.push({
      ...envelope(at(3, "19:00")),
      type: "Escalated",
      claim_id: "clm_prm_e",
      reason: "declined twice",
      escalation_route: "support@calder.example",
    });

    const state = await projectAll(events);

    expect(summarize(state, "USD").open).toEqual(usd(15));
    expect(state.promises.get("prm_e")?.status).toBe("Escalated");
  });

  it("replays truthfully to an earlier instant", async () => {
    const events = recoveredChain("prm_r", "Northwind Parcel", "delivery_window", 1, 12);

    const afterFiling = summarize(await projectAll(events, at(1, "18:40")), "USD");
    const endOfWeek = summarize(await projectAll(events), "USD");

    expect(afterFiling.recovered).toEqual(usd(0));
    expect(afterFiling.open).toEqual(usd(15));
    expect(endOfWeek.recovered).toEqual(usd(12));
    expect(endOfWeek.open).toEqual(usd(0));
  });

  it("does not count a proposed claim as open — nobody has said yes yet", async () => {
    const events = recoveredChain("prm_p", "Northwind Parcel", "delivery_window", 1, 12);

    const beforeConfirmation = summarize(await projectAll(events, at(1, "18:00")), "USD");

    expect(beforeConfirmation.open).toEqual(usd(0));
    expect(beforeConfirmation.recovered).toEqual(usd(0));
  });

  it("counts a round per merchant reply, so offer-counter-settle is two", async () => {
    const state = await projectAll(
      recoveredChain("prm_c", "Northwind Parcel", "delivery_window", 1, 12),
    );
    const claim = state.claims.get("clm_prm_c");

    expect(claim).toBeDefined();
    expect(claimRoundCount(claim as NonNullable<typeof claim>)).toBe(2);
  });
});
