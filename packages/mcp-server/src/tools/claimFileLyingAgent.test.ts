import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { ClaimViewSchema } from "@owed/domain";
import type { RecourseMessage, Respondent, RespondentMessage } from "@owed/recourse-protocol";
import { afterEach, describe, expect, it } from "vitest";
import type { MerchantDirectory, StatedRemedy } from "../merchants/directory.js";
import { type Harness, startHarness } from "../testing/harness.js";

/**
 * Filing against a merchant agent that answers, and answers something Owed should not
 * believe.
 *
 * The absent merchant is covered — `claimFileNoAgent.test.ts` drives a directory that
 * cannot answer, and `fileWithoutAgent` records the claim on an email or manual route. The
 * case below was covered nowhere: a merchant that is up, speaks valid recourse/v1, and lies
 * in the fields.
 *
 * What it cost. `MoneySchema` validates that an amount is three uppercase letters and an
 * integer, and says nothing about whether it is the currency anyone asked for. The
 * negotiator accepts on `standing.amount.minor >= willSettleAt.minor`, comparing integers
 * with no reference to the unit. So a merchant replying `SETTLE { minor: 1200, currency:
 * "EUR" }` to a claim asking USD 12.00 was **accepted**, written to the ledger, and spoken
 * to the household as "settled at twelve euros". Then `summarize` — which folds
 * settlements into a `zeroMoney(currency)` accumulator — threw `currency mismatch: USD vs
 * EUR` on the next read, and the ledger is append-only, so `ledger_summary` and
 * `promises_list` were both down permanently. One reply from one merchant took two of the
 * six tools out for good.
 *
 * The four reference agents cannot produce any of these replies: their MCP server declares
 * `outputSchema: RespondentMessageSchema` and `createMerchantAgent` returns that type, so
 * they are hard-wired honest. That is why a test double is the only way to reach this, and
 * why the gap survived eight conformance runs over real HTTP.
 */

/** A merchant that always says the same thing, whatever it is asked. */
function merchantSaying(reply: (claimId: string) => RespondentMessage): MerchantDirectory {
  return {
    respondentFor: (merchant: string, _remedy: StatedRemedy): Respondent => ({
      name: merchant,
      respond: (transcript: readonly RecourseMessage[]): RespondentMessage => {
        const claim = transcript[0];
        if (claim === undefined) throw new Error("no claim to answer");
        return reply(claim.claim_id);
      },
    }),
  };
}

const AT = "2026-10-18T18:30:00.000Z";

/** The promise the demo files on camera, and the one the seed leaves unfiled. */
const PROMISE = "prm_011";
const MERCHANT = "Northwind Parcel";

let harness: Harness;
let client: Client;

async function connect(merchants: MerchantDirectory): Promise<void> {
  harness = await startHarness({ merchants });
  const token = await harness.link();
  client = new Client({ name: "claim-file-lying-agent-test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(harness.mcpUrl, {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
}

afterEach(async () => {
  await client?.close();
  await harness?.close();
});

const spokenOf = (result: { content: unknown }) =>
  (result.content as Array<{ text?: string }>)[0]?.text ?? "";

/**
 * The route the ledger recorded for a claim.
 *
 * Read off `ClaimProposed` rather than the view, because `ClaimView` has no `route` field —
 * an earlier draft of this file asserted `view.route !== "agent"` and passed on `undefined`
 * for every claim ever filed, honest or not.
 */
async function proposedRoute(claimId: string): Promise<string | undefined> {
  const events = await harness.deps.store.read(harness.deps.householdId);
  const proposed = events.find(
    (event) => event.type === "ClaimProposed" && event.claim_id === claimId,
  );
  return proposed === undefined || proposed.type !== "ClaimProposed" ? undefined : proposed.route;
}

/** `confirm`, because without it the tool elicits and never reaches the merchant at all. */
const fileIt = () =>
  client.callTool({ name: "claim_file", arguments: { promise_id: PROMISE, confirm: true } });

const settleWith = (amount: { minor: number; currency: string }) =>
  merchantSaying((claim_id) => ({
    claim_id,
    at: AT,
    type: "SETTLE",
    amount,
    form: "credit",
  }));

/** The four replies that each used to be accepted, and what is wrong with each. */
const LIES = [
  {
    what: "settles in a currency nobody asked for",
    // 1200 minor units of anything cleared a 1200-minor USD reservation.
    amount: { minor: 1200, currency: "EUR" },
  },
  {
    what: "settles a negative amount",
    // `speakMoney` renders the sign, so this was read out as "minus eight dollars".
    amount: { minor: -800, currency: "USD" },
  },
  {
    what: "settles more than Owed can say out loud",
    /**
     * The currency fix's surviving twin, found by asking what else one reply can do.
     *
     * `numberToWords` throws at a billion major units and `speakMoney` calls it, while
     * `MoneySchema` accepts any safe integer and `formatMoney` renders anything — so this was
     * accepted, written to the append-only ledger, folded into the recovered total, and from
     * the next read on, `voice.ts` raised `RangeError: numberToWords supports values below one
     * billion` for every spoken summary. The card showed `$1000000000.00` the whole time,
     * which is why nothing noticed. Refused now by `isSpeakable`, in `filing.ts`, before the
     * append.
     */
    amount: { minor: 100_000_000_000, currency: "USD" },
  },
  {
    what: "settles nothing at all",
    /**
     * A refusal wearing a settlement's clothes.
     *
     * `DECLINE` is the message for "no remedy", and the protocol requires it to carry a reason
     * *and* an escalation route, because a merchant may refuse but may not leave a household
     * with nowhere to go. `SETTLE { minor: 0 }` closed the claim as a settlement, was spoken
     * as a recovery, and carried neither. Refused at the session; a zero *offer* is still
     * ordinary haggling, and the evaluation grid runs `anchor_ratio: 0` to measure one.
     */
    amount: { minor: 0, currency: "USD" },
  },
] as const;

describe.each(LIES)("a merchant agent that $what", ({ amount }) => {
  /**
   * It is not accepted as a settlement — and the claim is still recorded.
   *
   * Both halves matter. `store.append` runs after the whole negotiation, so before this was
   * fixed a `ProtocolViolation` discarded everything: no `ClaimProposed`, no `ClaimFiled`,
   * nothing in the ledger, and asking again started from scratch. That is the same failure
   * `fileWithoutAgent` exists to prevent for the unreachable case, which is why the fix
   * routes here rather than inventing a second kind of half-filed claim.
   */
  it("files the claim on the route that does not need the agent", async () => {
    await connect(settleWith(amount));

    const result = await fileIt();

    expect(result.isError ?? false, spokenOf(result)).toBe(false);
    const view = ClaimViewSchema.parse(result.structuredContent);

    expect(view.settled_amount, "nothing the merchant said was accepted").toBeUndefined();
    expect(view.state).toBe("Filed");
    // Nothing the merchant said reaches the transcript, so the card reads "Asked" and
    // stops — and `round_count` is zero because a round is a *reply*.
    expect(view.rounds.map((round) => round.type)).toStrictEqual(["CLAIM"]);
    expect(view.round_count).toBe(0);
    // Northwind Parcel publishes a claims contact, so there is somewhere to send it.
    expect(await proposedRoute(view.claim_id)).toBe("email");
  });

  /**
   * The assertion that matters: the ledger still reads afterwards.
   *
   * Append-only means an event `summarize` cannot fold is not a bad row to correct later,
   * it is permanent. Both read tools project through `summarize`.
   */
  it("leaves both read tools working", async () => {
    await connect(settleWith(amount));
    await fileIt();

    const summary = await client.callTool({ name: "ledger_summary", arguments: {} });
    expect(summary.isError ?? false, spokenOf(summary)).toBe(false);
    expect(spokenOf(summary)).not.toMatch(/minus|euro/i);

    const list = await client.callTool({ name: "promises_list", arguments: {} });
    expect(list.isError ?? false, spokenOf(list)).toBe(false);
  });

  /**
   * And the household hears an Owed sentence rather than an exception.
   *
   * A `ProtocolViolation` propagated from `session.ts` through `fileClaim` to a handler
   * that catches `NotFoundError` and rethrows the rest, so its message became
   * `content[0].text` and the brain read it out verbatim — "reply is in EUR and the claim
   * is in USD". Asserting the absence of digits is not enough to catch that, because that
   * sentence has none; this pins the line Owed actually says.
   */
  it("says why in words a speaker can say", async () => {
    await connect(settleWith(amount));

    const spoken = spokenOf(await fileIt());

    expect(spoken).toMatch(new RegExp(`${MERCHANT}'s agent answered with something`));
    expect(spoken).not.toMatch(/[0-9]/);
    expect(spoken).not.toMatch(/https?:|[<>{}]|\bError\b|currency|minor/);
  });
});

/**
 * The honest merchant still settles.
 *
 * Without this the three tests above pass against a build that refuses every merchant,
 * which is the failure mode a check like this is for: all four reference agents are honest,
 * so a currency check that was too strict would read as green here and break the demo.
 */
describe("a merchant agent that answers properly", () => {
  it("still settles, in the claim's own currency", async () => {
    harness = await startHarness();
    const token = await harness.link();
    client = new Client({ name: "claim-file-honest-agent-test", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(harness.mcpUrl, {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }),
    );

    const result = await fileIt();

    expect(result.isError ?? false, spokenOf(result)).toBe(false);
    const view = ClaimViewSchema.parse(result.structuredContent);
    expect(await proposedRoute(view.claim_id), "negotiated, not routed around").toBe("agent");
    expect(view.settled_amount?.currency).toBe("USD");
    expect(view.settled_amount?.minor).toBeGreaterThan(0);
    expect(view.round_count, "the merchant actually replied").toBeGreaterThan(0);
  });
});
