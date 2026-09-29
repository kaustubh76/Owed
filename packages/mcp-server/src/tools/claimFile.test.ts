import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { ClaimViewSchema, LedgerSummaryViewSchema, usd } from "@owed/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Harness, startHarness } from "../testing/harness.js";

/**
 * Filing a claim is the only thing Owed does that changes anything in the world, so each
 * test gets its own ledger rather than inheriting one another's writes.
 */
let harness: Harness;
let client: Client;

beforeEach(async () => {
  harness = await startHarness();
  const token = await harness.link();
  client = new Client({ name: "claim-file-test", version: "1.0.0" });
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

describe("claim_file", () => {
  /**
   * The restraint the whole product rests on. A promise Owed could not see enough of is
   * never filed, however much money is on the table.
   */
  it("refuses a promise it could not see enough of, and says how little it saw", async () => {
    const result = await call("claim_file", { promise_id: "prm_010", confirm: true });

    expect(result.isError).toBe(true);
    expect(spokenOf(result)).toContain("won't file");
    expect(spokenOf(result)).toContain("twenty percent");
  });

  it("leaves a refused promise unclaimed in the ledger", async () => {
    await call("claim_file", { promise_id: "prm_010", confirm: true });
    const check = await call("promise_check", { promise_id: "prm_010" });

    expect(ClaimViewSchema.safeParse(check.structuredContent).success).toBe(false);
    const summary = await call("ledger_summary", {});
    expect(LedgerSummaryViewSchema.parse(summary.structuredContent).open).toEqual(usd(8));
  });

  it("refuses a promise that was kept", async () => {
    const result = await call("claim_file", { promise_id: "prm_008", confirm: true });

    expect(result.isError).toBe(true);
    expect(spokenOf(result)).toContain("kept that one");
  });

  it("proposes without filing when nobody has said yes", async () => {
    const result = await call("claim_file", { promise_id: "prm_011" });
    const view = ClaimViewSchema.parse(result.structuredContent);

    expect(view.state).toBe("Proposed");
    expect(view.expected).toEqual(usd(8));
    expect(spokenOf(result)).toContain("Shall I file it");

    // Nothing was written: open money has not moved.
    const summary = await call("ledger_summary", {});
    expect(LedgerSummaryViewSchema.parse(summary.structuredContent).open).toEqual(usd(8));
  });

  it("files and settles once the household says yes", async () => {
    const result = await call("claim_file", { promise_id: "prm_011", confirm: true });
    const view = ClaimViewSchema.parse(result.structuredContent);

    expect(view.state).toBe("Settled");
    expect(view.settled_amount).toEqual(usd(8));
    expect(view.rounds.map((round) => round.type)).toEqual(["CLAIM", "OFFER", "COUNTER", "SETTLE"]);
    expect(view.round_count).toBe(2);
  });

  it("never asks for more than the merchant's own wording allows", async () => {
    const result = await call("claim_file", { promise_id: "prm_011", confirm: true });
    const view = ClaimViewSchema.parse(result.structuredContent);

    // Delivery Guarantee 4.1 publishes eight dollars and allows up to ten.
    expect(view.ask).toEqual(usd(10));
    for (const round of view.rounds) {
      if (round.amount) expect(round.amount.minor).toBeLessThanOrEqual(usd(10).minor);
    }
  });

  it("moves the open figure by what it settled", async () => {
    await call("claim_file", { promise_id: "prm_011", confirm: true });
    const summary = await call("ledger_summary", {});

    expect(LedgerSummaryViewSchema.parse(summary.structuredContent).open).toEqual(usd(16));
  });

  it("does not file the same claim twice", async () => {
    const first = await call("claim_file", { promise_id: "prm_011", confirm: true });
    const second = await call("claim_file", { promise_id: "prm_011", confirm: true });

    expect(ClaimViewSchema.parse(second.structuredContent)).toEqual(
      ClaimViewSchema.parse(first.structuredContent),
    );
    const summary = await call("ledger_summary", {});
    expect(LedgerSummaryViewSchema.parse(summary.structuredContent).open).toEqual(usd(16));
  });

  it("reports an already-filed claim rather than refiling it", async () => {
    const result = await call("claim_file", { promise_id: "prm_002", confirm: true });
    const view = ClaimViewSchema.parse(result.structuredContent);

    expect(view.claim_id).toBe("clm_002");
    expect(view.state).toBe("Recovered");
  });
});
