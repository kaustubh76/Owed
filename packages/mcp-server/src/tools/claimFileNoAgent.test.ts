import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { ClaimViewSchema } from "@owed/domain";
import { builtinPolicies } from "@owed/policy-library";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MerchantDirectory } from "../merchants/directory.js";
import { type Harness, startHarness } from "../testing/harness.js";
import { routeWithoutAgent } from "./claimFile.js";

/**
 * Filing when no merchant agent answers.
 *
 * This branch used to return an error saying "I'll keep the claim open" and keep nothing —
 * no events, no claim, nothing in the ledger. The household was told their claim had been
 * recorded when it had not, and asking again started from scratch. It is also where
 * `ClaimRoute`'s `email` and `manual` members live: only `agent` had ever been written,
 * because `fileClaim` requires a `Respondent` and this path never reached one.
 *
 * The directory below is the real port with an implementation that cannot answer, which is
 * what a merchant whose agent is down looks like from here.
 */
const unreachable: MerchantDirectory = {
  respondentFor: () => undefined,
};

let harness: Harness;
let client: Client;

beforeEach(async () => {
  harness = await startHarness({ merchants: unreachable });
  const token = await harness.link();
  client = new Client({ name: "claim-file-no-agent-test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(harness.mcpUrl, {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
});

afterEach(async () => {
  await client?.close();
  await harness?.close();
});

const call = (name: string, args: Record<string, unknown>) =>
  client.callTool({ name, arguments: args });
const spokenOf = (result: { content: unknown }) =>
  (result.content as Array<{ text?: string }>)[0]?.text ?? "";

/** The one `ClaimProposed` the ledger holds for a claim, so its route can be read back. */
async function proposedRoute(claimId: string): Promise<string | undefined> {
  const events = await harness.deps.store.read(harness.deps.householdId);
  const proposed = events.find(
    (event) => event.type === "ClaimProposed" && event.claim_id === claimId,
  );
  return proposed === undefined || proposed.type !== "ClaimProposed" ? undefined : proposed.route;
}

describe("claim_file when no agent answers", () => {
  it("records the claim instead of dropping it", async () => {
    const result = await call("claim_file", { promise_id: "prm_011", confirm: true });

    // Not an error. There is nobody to argue with, but there is still a claim.
    // `toBeFalsy()` would also pass on `0` and `""`; `contract.test.ts` uses this form.
    expect(result.isError ?? false).toBe(false);
    const view = ClaimViewSchema.parse(result.structuredContent);
    expect(view.claim_id).toBe("clm_prm_011");
    expect(view.merchant).toBe("Northwind Parcel");

    /**
     * `ClaimProposed` then `ClaimFiled` and no recourse messages projects to exactly this:
     * filed, with the one round that records Owed asking, and nothing after it. The card
     * reads "Asked" and stops, which is what happened.
     *
     * `round_count` is zero rather than one because a round is a reply —
     * `countRounds` counts respondent messages — and nobody replied.
     */
    expect(view.state).toBe("Filed");
    expect(view.rounds.map((round) => round.type)).toStrictEqual(["CLAIM"]);
    expect(view.rounds[0]?.amount).toStrictEqual({ minor: 1000, currency: "USD" });
    expect(view.round_count).toBe(0);
  });

  /**
   * The amounts are the published ones, not placeholders. A claim nobody answered is still
   * a claim for what the merchant's own clause says, which is the whole point of recording
   * it: the household can act on the figure.
   */
  it("records what the clause says is owed", async () => {
    const result = await call("claim_file", { promise_id: "prm_011", confirm: true });
    const view = ClaimViewSchema.parse(result.structuredContent);

    expect(view.ask).toStrictEqual({ minor: 1000, currency: "USD" });
    expect(view.expected).toStrictEqual({ minor: 800, currency: "USD" });
    expect(view.settled_amount).toBeUndefined();
  });

  it("writes the route to the ledger, which only ever said agent before", async () => {
    await call("claim_file", { promise_id: "prm_011", confirm: true });

    // Northwind Parcel publishes a claims contact, so there is somewhere to send it.
    expect(await proposedRoute("clm_prm_011")).toBe("email");
  });

  it("says what will happen to it, without reading out an address", async () => {
    const result = await call("claim_file", { promise_id: "prm_011", confirm: true });

    expect(spokenOf(result)).toContain("can't reach Northwind Parcel's agent");
    expect(spokenOf(result)).toContain("address they publish for claims");
    // The spoken line is gated for digits, so the address itself is on the card, not aloud.
    expect(spokenOf(result)).not.toMatch(/@/);
  });

  /**
   * The failure the old message implied and did not deliver. Being told a claim is open and
   * finding it gone is worse than being told it could not be filed.
   */
  it("finds the claim again afterwards rather than filing a second one", async () => {
    const first = await call("claim_file", { promise_id: "prm_011", confirm: true });
    const again = await call("claim_file", { promise_id: "prm_011", confirm: true });

    expect(ClaimViewSchema.parse(again.structuredContent)).toStrictEqual(
      ClaimViewSchema.parse(first.structuredContent),
    );

    const status = await call("claim_status", { claim_id: "clm_prm_011" });
    expect(ClaimViewSchema.parse(status.structuredContent).state).toBe("Filed");
  });

  /** The restraint is unchanged: no agent is not a reason to file something unseen. */
  it("still refuses a promise it could not see enough of", async () => {
    const result = await call("claim_file", { promise_id: "prm_010", confirm: true });

    expect(result.isError).toBe(true);
    expect(spokenOf(result)).toContain("won't file");
  });

  /** And still asks first. An unreachable merchant does not imply consent. */
  it("still needs the household's yes", async () => {
    const result = await call("claim_file", { promise_id: "prm_011" });
    expect(spokenOf(result)).toContain("Shall I file it?");
    expect(await proposedRoute("clm_prm_011")).toBeUndefined();
  });
});

/**
 * Which route, from the merchant's own policy.
 *
 * Tested here rather than through the tool because the seeded week has exactly one filable
 * promise and it belongs to the merchant that publishes a contact — so `manual` is not
 * reachable through `claim_file` without inventing a merchant, and an unreachable branch is
 * one nobody has checked.
 */
describe("choosing between the two agentless routes", () => {
  it("sends it to the address when the merchant publishes one", () => {
    expect(routeWithoutAgent({ claims_contact: "claims@northwind-parcel.example" })).toBe("email");
  });

  it("hands it back to the household when the merchant publishes nowhere to send it", () => {
    expect(routeWithoutAgent({})).toBe("manual");
    expect(routeWithoutAgent(undefined)).toBe("manual");
  });

  /**
   * Against the shipped policies rather than against invented ones, so that adding a
   * contact to a merchant — or dropping one — shows up here.
   */
  it("agrees with what the shipped policies actually publish", () => {
    const routes = builtinPolicies()
      .all()
      .map((policy) => `${policy.merchant}: ${routeWithoutAgent(policy)}`)
      .sort();

    expect(routes).toStrictEqual([
      "Alder Home Services: manual",
      "Calder & Co.: manual",
      "Meridian Rides: manual",
      "Northwind Parcel: email",
    ]);
  });
});
