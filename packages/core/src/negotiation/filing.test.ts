import type { OwedPromise } from "@owed/domain";
import { interval, usd } from "@owed/domain";
import { describe, expect, it } from "vitest";
import { project } from "../ledger/projections.js";
import { SeededIdGen } from "../time/determinism.js";
import { fileWithoutAgent } from "./filing.js";
import type { RemedyBounds } from "./negotiator.js";

/**
 * Filing a claim that no agent answered.
 *
 * `ClaimRoute` has had three members since it was declared and only `agent` was ever
 * written, because `fileClaim` requires a `Respondent` and a merchant with no reachable
 * agent took a path that produced no events at all. The tool said "I'll keep the claim
 * open" and kept nothing.
 *
 * Both of the other two routes are reachable here, which they are not through
 * `claim_file`: the seeded week has exactly one filable promise and it belongs to the one
 * merchant that publishes a contact. `claimFileNoAgent.test.ts` covers the tool.
 */

const HH = "hh_file";

const promise: OwedPromise = {
  id: "prm_900",
  household_id: HH,
  merchant: "Stonewall Freight",
  source_ref: "msg_prm_900",
  kind: "delivery_window",
  made_at: "2026-10-10T04:15:00-07:00",
  window: interval("2026-10-11T13:00:00-07:00", "2026-10-11T17:00:00-07:00"),
  amount_at_stake: usd(54),
  currency: "USD",
  confidence: 1,
  status: "Breached",
};

const bounds: RemedyBounds = {
  reservation: usd(8),
  ceiling: usd(10),
  clause: { id: "stonewall/guarantee#1", title: "Delivery Guarantee 1" },
};

function file(route: "email" | "manual", attach = true) {
  return fileWithoutAgent({
    householdId: HH,
    claimId: "clm_prm_900",
    promise,
    bounds,
    route,
    proposedAt: "2026-10-12T02:30:00-07:00",
    filedAt: "2026-10-12T02:31:00-07:00",
    confirmedBy: "household",
    idGen: new SeededIdGen(),
    ...(attach ? { attachedEvidenceIds: ["evd_scan_900"] } : {}),
  });
}

describe("recording a claim nobody answered", () => {
  it("emits the same pair a negotiated claim starts with, and nothing after it", () => {
    const events = file("email");

    expect(events.map((event) => event.type)).toStrictEqual(["ClaimProposed", "ClaimFiled"]);
  });

  it("carries the route, which is the whole reason the two members exist", () => {
    for (const route of ["email", "manual"] as const) {
      const [proposed] = file(route);
      expect(proposed?.type === "ClaimProposed" && proposed.route).toBe(route);
    }
  });

  /**
   * The published figure, not a placeholder. Recording the claim is only worth anything if
   * the amount is the one the merchant's own clause commits them to — that is what the
   * household acts on when they have to pursue it themselves.
   */
  it("asks for the ceiling and records the reservation as what is owed", () => {
    const [proposed] = file("manual");
    if (proposed?.type !== "ClaimProposed") throw new Error("expected ClaimProposed");

    expect(proposed.ask).toStrictEqual(usd(10));
    expect(proposed.expected).toStrictEqual(usd(8));
    expect(proposed.merchant).toBe("Stonewall Freight");
    expect(proposed.promise_id).toBe("prm_900");
  });

  it("keeps the evidence with the claim, and keeps none when told not to", () => {
    const [, withEvidence] = file("manual", true);
    const [, without] = file("manual", false);

    expect(withEvidence?.type === "ClaimFiled" && withEvidence.attached_evidence_ids).toStrictEqual(
      ["evd_scan_900"],
    );
    expect(without?.type === "ClaimFiled" && without.attached_evidence_ids).toStrictEqual([]);
  });

  it("records the household as the one who confirmed it", () => {
    const [, filed] = file("email");
    expect(filed?.type === "ClaimFiled" && filed.confirmed_by).toBe("household");
  });

  /**
   * What the household sees. The claim projects to `Filed` with the one round that says
   * Owed asked — and `round_count` zero, because a round is a reply and nobody replied.
   */
  it("projects to a filed claim with an ask and no answer", () => {
    const state = project(file("email").map((event, index) => ({ ...event, seq: index + 1 })));
    const claim = state.claims.get("clm_prm_900");

    expect(claim?.state).toBe("Filed");
    expect(claim?.route).toBe("email");
    expect(claim?.rounds.map((round) => round.type)).toStrictEqual(["CLAIM"]);
    expect(claim?.settled_amount).toBeUndefined();

    // These two events alone carry no `PromiseCaptured`, so this projection has no promise
    // view for the claim to attach to — which is why the back-link is empty here and not a
    // claim about the product. That asking again finds this claim rather than filing a
    // second one is asserted against the real ledger in `claimFileNoAgent.test.ts`.
    expect(state.promises.get("prm_900")).toBeUndefined();
  });
});
