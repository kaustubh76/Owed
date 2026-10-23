import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { ClaimViewSchema } from "@owed/domain";
import type { RecourseMessage, Respondent, RespondentMessage } from "@owed/recourse-protocol";
import { describe, expect, it } from "vitest";
import type { MerchantDirectory, StatedRemedy } from "../merchants/directory.js";
import { type Harness, startHarness } from "../testing/harness.js";

/**
 * Filing the same promise twice at once.
 *
 * `claim_file` reads the ledger, checks whether this promise already has a claim, negotiates
 * with the merchant, and only then appends. The check and the write are separated by the whole
 * negotiation — up to three round trips to an agent across a network — so two calls that arrive
 * together both pass the check. Nothing serializes tool calls, and the store cannot reject the
 * second batch either: `#reserveSequenceBlock` hands concurrent appends **disjoint** sequence
 * numbers, so `attribute_not_exists(sk)` guarantees append-only integrity and says nothing about
 * logical uniqueness.
 *
 * Reachable without anything exotic: two taps on the home's "File it" chip, two Echo devices in
 * one household, or the brain retrying a tool call it believes timed out.
 *
 * **The default agents cannot reproduce it**, which is why this file injects its own. They answer
 * in process without yielding, so control never leaves `claim_file` between the check and the
 * append and the window is closed by accident. A merchant across a network does yield. That is
 * the same trap as §D24, where the four reference agents were structurally incapable of the lie
 * being guarded against — a boundary tested only against a fixture that cannot misbehave is a
 * boundary that is not tested.
 *
 * Two different properties live here, and keeping them apart is the point:
 *
 *  - **The figures are right either way**, which is the guarantee a household cares about and is
 *    pinned here end to end. *Why* a doubled claim reads correctly belongs to the projection, and
 *    is asserted where it lives, in `core/src/ledger/projections.test.ts` — `ClaimProposed` is a
 *    constructor rather than a merge, so a second lifecycle rebuilds the claim instead of
 *    compounding it. Note that this first test passes with the guard removed as well: it is the
 *    outcome being pinned, not the mechanism, and the second test is the one that fails without it.
 *  - **One promise is one claim.** The merchant should hear about it once. The frequency cap
 *    exists so Owed holds a claim back "rather than pile on", and it counts distinct claims, so
 *    it never saw this.
 */

const AGENT_DELAY_MS = 60;

/** The promise the demo files on camera, and the one the seed leaves unfiled. */
const PROMISE = "prm_011";
const MERCHANT = "Northwind Parcel";
const AT = "2026-10-18T18:30:00.000Z";

/**
 * An honest merchant that takes its time, and counts how often it was asked.
 *
 * Settles immediately at the figure it is handed, so the negotiation is one round and the only
 * variable under test is how many times Owed opened one.
 */
function slowHonestMerchant(): { directory: MerchantDirectory; asked: () => number } {
  let asked = 0;
  return {
    asked: () => asked,
    directory: {
      respondentFor: (merchant: string, _remedy: StatedRemedy): Respondent => ({
        name: merchant,
        respond: async (transcript: readonly RecourseMessage[]): Promise<RespondentMessage> => {
          const claim = transcript[0];
          if (claim === undefined) throw new Error("no claim to answer");
          asked += 1;
          await new Promise((resolve) => setTimeout(resolve, AGENT_DELAY_MS));
          return {
            claim_id: claim.claim_id,
            at: AT,
            type: "SETTLE",
            amount: { minor: 800, currency: "USD" },
            form: "credit",
          };
        },
      }),
    },
  };
}

/** Everything a household can observe afterwards, plus what the ledger actually holds. */
interface Observed {
  recovered: unknown;
  open: unknown;
  state: string;
  roundCount: number;
  rounds: string[];
  settled: unknown;
  claimRows: string[];
  asked: number;
}

async function fileIt(client: Client): Promise<unknown> {
  return client.callTool({
    name: "claim_file",
    arguments: { promise_id: PROMISE, confirm: true },
  });
}

/** One run against a fresh ledger: file once, or twice at the same moment, then look. */
async function observe(calls: 1 | 2): Promise<Observed> {
  const merchant = slowHonestMerchant();
  const harness: Harness = await startHarness({ merchants: merchant.directory });
  const clients: Client[] = [];
  try {
    const token = await harness.link();

    const connect = async (): Promise<Client> => {
      const client = new Client({ name: "claim-file-concurrent-test", version: "1.0.0" });
      await client.connect(
        new StreamableHTTPClientTransport(harness.mcpUrl, {
          requestInit: { headers: { authorization: `Bearer ${token}` } },
        }),
      );
      clients.push(client);
      return client;
    };

    // A client each, because two sessions is the honest shape of two devices — and a single
    // session could serialize in the transport and hide the whole thing.
    if (calls === 1) {
      await fileIt(await connect());
    } else {
      const [a, b] = [await connect(), await connect()];
      await Promise.all([fileIt(a), fileIt(b)]);
    }

    const reader = clients[0] as Client;
    const summary = await reader.callTool({ name: "ledger_summary", arguments: {} });
    const status = await reader.callTool({
      name: "claim_status",
      arguments: { claim_id: `clm_${PROMISE}` },
    });
    const view = ClaimViewSchema.parse(status.structuredContent);
    const summaryContent = summary.structuredContent as { recovered: unknown; open: unknown };

    const events = await harness.deps.store.read(harness.deps.householdId);

    return {
      recovered: summaryContent.recovered,
      open: summaryContent.open,
      state: view.state,
      roundCount: view.round_count,
      rounds: view.rounds.map((round) => round.type),
      settled: view.settled_amount,
      claimRows: events
        .filter((event) => "claim_id" in event && event.claim_id === `clm_${PROMISE}`)
        .map((event) => event.type),
      asked: merchant.asked(),
    };
  } finally {
    for (const client of clients) await client.close();
    await harness.close();
  }
}

describe("two taps on File it, at the same moment", () => {
  /**
   * The invariant that is doing all the work, finally written down.
   *
   * Compared against a single filing measured in the same test rather than against copied
   * literals, so the expectation cannot drift away from what the product actually does.
   */
  it("leaves every figure a household can see identical to filing once", async () => {
    const [once, twice] = [await observe(1), await observe(2)];

    expect(twice.recovered).toEqual(once.recovered);
    expect(twice.open).toEqual(once.open);
    expect(twice.state).toBe(once.state);
    expect(twice.settled).toEqual(once.settled);
    expect(twice.roundCount, "a round is a reply, and there was one").toBe(once.roundCount);
    expect(twice.rounds).toStrictEqual(once.rounds);
    expect(once.rounds).toStrictEqual(["CLAIM", "SETTLE"]);
  });

  /**
   * And one promise is one claim, in the ledger and at the merchant.
   *
   * Before the in-flight guard this wrote `ClaimProposed`, `ClaimFiled` and `Settled` twice for
   * one claim id — two settlements of eight dollars for one eight-dollar debt, in the
   * append-only log this submission offers as evidence — and asked the merchant twice in the
   * same instant for the same promise.
   */
  it("files one claim and asks the merchant once", async () => {
    const twice = await observe(2);

    expect(twice.asked, `${MERCHANT} should hear about one promise once`).toBe(1);
    expect(twice.claimRows).toStrictEqual(["ClaimProposed", "ClaimFiled", "Settled"]);
  });
});
