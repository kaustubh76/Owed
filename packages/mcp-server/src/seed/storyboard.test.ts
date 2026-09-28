import { claimRoundCount, MemoryEventStore, project, summarize } from "@owed/core";
import { coveragePercent, usd } from "@owed/domain";
import { describe, expect, it } from "vitest";
import {
  ARCS,
  at,
  CURRENCY,
  HOUSEHOLD_ID,
  STORYBOARD_PROACTIVE_AT,
  STORYBOARD_QUERY_AT,
  storyboardEvents,
} from "./storyboard.js";

async function stateAt(instant?: string) {
  const store = new MemoryEventStore();
  await store.append(storyboardEvents());
  return project(await store.read(HOUSEHOLD_ID, instant));
}

/**
 * The golden test. Every number spoken in the demo video is an assertion here, so
 * breaking the demo turns CI red (plan §8). Figures are frozen in docs/contract-v1.md §6.
 */
describe("storyboard week", () => {
  it("is deterministic — two builds produce identical events", () => {
    expect(storyboardEvents()).toEqual(storyboardEvents());
  });

  it("replays in occurrence order", () => {
    const occurred = storyboardEvents().map((e) => e.occurred_at);
    expect([...occurred].sort()).toEqual(occurred);
  });

  it("reports the headline the household hears on Sunday", async () => {
    const summary = summarize(await stateAt(STORYBOARD_QUERY_AT), CURRENCY);

    expect(summary.recovered).toEqual(usd(47));
    expect(summary.open).toEqual(usd(8));
    expect(summary.kept).toBe(2);
    expect(summary.declined).toBe(1);
  });

  it("settles the hero claim at twelve dollars in two rounds", async () => {
    const state = await stateAt(STORYBOARD_QUERY_AT);
    const claim = state.claims.get("clm_002");

    expect(claim?.state).toBe("Recovered");
    expect(claim?.settled_amount).toEqual(usd(12));
    expect(claim?.recovered_amount).toEqual(usd(12));
    expect(claimRoundCount(claim as NonNullable<typeof claim>)).toBe(2);
  });

  it("counters at exactly the merchant's own stated remedy, citing the clause", async () => {
    const state = await stateAt(STORYBOARD_QUERY_AT);
    const counter = state.claims.get("clm_002")?.rounds.find((r) => r.type === "COUNTER");

    expect(counter?.amount).toEqual(usd(12));
    expect(counter?.justification?.policy_clause).toBe("Delivery Guarantee 4.2");
  });

  it("never asks for more than the ask, and never counters above it", async () => {
    const state = await stateAt();
    for (const claim of state.claims.values()) {
      for (const round of claim.rounds) {
        if (round.type === "COUNTER" && round.amount) {
          expect(round.amount.minor).toBeLessThanOrEqual(claim.ask.minor);
        }
      }
    }
  });

  it("declines to file the Sunday parcel, and says how little it watched", async () => {
    const state = await stateAt(STORYBOARD_QUERY_AT);
    const view = state.promises.get("prm_010");

    expect(view?.status).toBe("Suspected");
    expect(view?.claim_id).toBeUndefined();
    expect(coveragePercent(view?.assessment?.coverage ?? 0)).toBe(20);
  });

  it("only marks money recovered once the credit has been observed", async () => {
    const beforeCredit = await stateAt(at("wed", "09:00"));
    const afterCredit = await stateAt(at("wed", "11:00"));

    // Wednesday morning: the hero claim has settled but the credit has not landed,
    // so only Monday's ride counts as recovered. The settled twelve is still "open".
    expect(beforeCredit.claims.get("clm_002")?.state).toBe("Settled");
    expect(summarize(beforeCredit, CURRENCY).recovered).toEqual(usd(3));
    expect(summarize(beforeCredit, CURRENCY).open).toEqual(usd(12));

    // Two hours later the credit is observed, and only then does it count.
    expect(afterCredit.claims.get("clm_002")?.state).toBe("Recovered");
    expect(summarize(afterCredit, CURRENCY).recovered).toEqual(usd(15));
    expect(summarize(afterCredit, CURRENCY).open).toEqual(usd(0));
  });

  it("has nothing filed for the hero before the household says yes", async () => {
    const justBefore = await stateAt(at("tue", "18:00"));

    expect(justBefore.claims.get("clm_002")?.state).toBe("Proposed");
    expect(summarize(justBefore, CURRENCY).open).toEqual(usd(0));
  });

  it("is ready to speak at the moment Owed interrupts on Tuesday", async () => {
    const state = await stateAt(STORYBOARD_PROACTIVE_AT);
    expect(state.promises.get("prm_002")?.assessment?.verdict).toBe("Breached");
  });

  /**
   * These two caught a real bug: a refund promise dated *after* its own breach, so
   * the assessment arrived before the promise existed and was silently dropped. The
   * weekly totals still came out right by luck, which is exactly why totals alone
   * are not enough.
   */
  it("orders every arc causally — nothing happens to a promise before it is made", () => {
    for (const arc of ARCS) {
      const made = arc.promise.made_at;
      expect(arc.assessed_at >= made, `${arc.promise.id} assessed before it was made`).toBe(true);

      const claim = arc.claim;
      if (!claim) continue;

      expect(claim.proposed_at >= arc.assessed_at, `${claim.id} proposed before assessment`).toBe(
        true,
      );
      expect(claim.filed_at >= claim.proposed_at, `${claim.id} filed before it was proposed`).toBe(
        true,
      );

      for (const exchange of claim.exchanges) {
        expect(exchange.at >= claim.filed_at, `${claim.id} exchanged before filing`).toBe(true);
      }
      if (claim.outcome.kind !== "open") {
        const last = claim.exchanges.at(-1)?.at ?? claim.filed_at;
        expect(claim.outcome.at >= last, `${claim.id} concluded before its last exchange`).toBe(
          true,
        );
      }
      if (claim.outcome.kind === "settled" && claim.outcome.recovered_at !== undefined) {
        expect(claim.outcome.recovered_at >= claim.outcome.at).toBe(true);
      }
    }
  });

  it("leaves no promise unresolved by the end of the week", async () => {
    const state = await stateAt(STORYBOARD_QUERY_AT);

    expect(state.promises.size).toBe(ARCS.length);
    for (const [id, view] of state.promises) {
      expect(["Watching", "Captured", "Candidate"], `${id} was never assessed`).not.toContain(
        view.status,
      );
    }
  });

  it("puts what still needs attention at the top of the card", async () => {
    const summary = summarize(await stateAt(STORYBOARD_QUERY_AT), CURRENCY);
    const ordered = [...summary.items].sort(
      (a, b) =>
        (a.status === "Escalated" ? 0 : a.status === "Negotiating" ? 1 : 2) -
        (b.status === "Escalated" ? 0 : b.status === "Negotiating" ? 1 : 2),
    );

    expect(ordered[0]?.status).toBe("Escalated");
    expect(ordered[0]?.merchant).toBe("Calder & Co.");
    expect(ordered[1]?.status).toBe("Negotiating");
  });
});
