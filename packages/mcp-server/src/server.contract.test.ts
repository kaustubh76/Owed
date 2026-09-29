import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { ClaimViewSchema, EvidenceViewSchema, LedgerSummaryViewSchema, usd } from "@owed/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Harness, startHarness } from "./testing/harness.js";
import { VIEW_URIS } from "./views.js";
import { MAX_SPOKEN_CHARS } from "./voice.js";

/**
 * The tool contract, exercised over real Streamable HTTP with the real client, through
 * a real access token. Gate 4 in the plan.
 */
let harness: Harness;
let client: Client;

beforeAll(async () => {
  harness = await startHarness();
  const token = await harness.link();

  client = new Client({ name: "owed-contract-test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(harness.mcpUrl, {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
});

afterAll(async () => {
  await client?.close();
  await harness?.close();
});

describe("tools/list", () => {
  it("advertises only frozen tool names", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();

    // Frozen at D0. Alexa+ locks tool signatures at certification, and the storyboard
    // asserts against them. docs/contract-v1.md §3.
    expect(names).toEqual([
      "claim_file",
      "claim_status",
      "evidence_get",
      "ledger_summary",
      "promise_check",
      "promises_list",
    ]);
  });

  it("gives every tool a description and an input schema", async () => {
    const { tools } = await client.listTools();

    for (const tool of tools) {
      expect(tool.description, `${tool.name} needs a description`).toBeTruthy();
      expect(tool.inputSchema, `${tool.name} needs an inputSchema`).toBeTruthy();
    }
  });

  it("links every tool to the view that renders it", async () => {
    const { tools } = await client.listTools();

    for (const tool of tools) {
      const meta = tool._meta as { ui?: { resourceUri?: string } } | undefined;
      expect(Object.values(VIEW_URIS)).toContain(meta?.ui?.resourceUri);
    }
  });
});

describe("tools/call ledger_summary", () => {
  it("answers with the storyboard's numbers", async () => {
    const result = await client.callTool({ name: "ledger_summary", arguments: {} });
    const view = LedgerSummaryViewSchema.parse(result.structuredContent);

    expect(view.recovered).toEqual(usd(47));
    expect(view.open).toEqual(usd(8));
    expect(view.kept).toBe(2);
    expect(view.declined).toBe(1);
    expect(view.period).toBe("week");
  });

  it("returns exactly one content block, and it is speakable", async () => {
    const result = await client.callTool({ name: "ledger_summary", arguments: {} });
    const content = result.content as Array<{ type: string; text?: string }>;

    expect(content).toHaveLength(1);
    expect(content[0]?.type).toBe("text");

    const spoken = content[0]?.text ?? "";
    expect(spoken.length).toBeLessThanOrEqual(MAX_SPOKEN_CHARS);
    expect(spoken).not.toMatch(/[0-9]/);
    expect(spoken).not.toMatch(/[*_#`|]/);
    expect(spoken).not.toMatch(/https?:\/\//);
  });

  it("says the numbers aloud the way the storyboard scripts them", async () => {
    const result = await client.callTool({ name: "ledger_summary", arguments: {} });
    const spoken = (result.content as Array<{ text?: string }>)[0]?.text ?? "";

    expect(spoken).toContain("forty-seven dollars");
    expect(spoken).toContain("eight dollars is still open");
    expect(spoken).toContain("Two promises were kept");
    expect(spoken).toContain("twenty percent");
  });

  it("carries the view pointer and a payload the view can read", async () => {
    const result = await client.callTool({ name: "ledger_summary", arguments: {} });
    const meta = result._meta as { ui?: { resourceUri?: string } } | undefined;

    expect(meta?.ui?.resourceUri).toBe(VIEW_URIS.ledger);
    expect(LedgerSummaryViewSchema.safeParse(result._meta?.["owed/data"]).success).toBe(true);
  });

  it("rejects an unknown period rather than guessing", async () => {
    const result = await client.callTool({
      name: "ledger_summary",
      arguments: { period: "fortnight" },
    });

    expect(result.isError).toBe(true);
  });
});

describe("resources/read", () => {
  it("serves the ledger view as a self-contained MCP App document", async () => {
    const result = await client.readResource({ uri: VIEW_URIS.ledger });
    const [content] = result.contents as Array<{ mimeType?: string; text?: string }>;

    expect(content?.mimeType).toBe(RESOURCE_MIME_TYPE);
    expect(content?.text ?? "").toContain("<!doctype html>");
    expect(content?.text ?? "").not.toMatch(/<script[^>]+src=/);
  });
});

describe("the read tools", () => {
  it("lists promises, and says how many are waiting on a yes", async () => {
    const result = await client.callTool({ name: "promises_list", arguments: {} });
    const spoken = (result.content as Array<{ text?: string }>)[0]?.text ?? "";

    expect(spoken).toContain("I'm watching");
    expect(spoken).toContain("ready to file");
  });

  it("narrows to one merchant", async () => {
    const result = await client.callTool({
      name: "promises_list",
      arguments: { merchant: "Calder & Co." },
    });
    const view = LedgerSummaryViewSchema.parse(result.structuredContent);

    expect(view.items.length).toBeGreaterThan(0);
    expect(view.items.every((item) => item.merchant === "Calder & Co.")).toBe(true);
  });

  /** The trust beat, from the tool that has to carry it. */
  it("explains a declined promise by naming what it did not see", async () => {
    const result = await client.callTool({
      name: "promise_check",
      arguments: { promise_id: "prm_010" },
    });
    const view = EvidenceViewSchema.parse(result.structuredContent);
    const spoken = (result.content as Array<{ text?: string }>)[0]?.text ?? "";

    expect(view.verdict).toBe("Suspected");
    expect(view.gaps.length).toBeGreaterThan(0);
    expect(spoken).toContain("not claiming");
    expect(spoken).toContain("twenty percent");
  });

  it("shows a claim as an exchange, not a status", async () => {
    const result = await client.callTool({
      name: "claim_status",
      arguments: { claim_id: "clm_002" },
    });
    const view = ClaimViewSchema.parse(result.structuredContent);

    expect(view.rounds.map((round) => round.type)).toEqual(["CLAIM", "OFFER", "COUNTER", "SETTLE"]);
    expect(view.round_count).toBe(2);
    expect(view.settled_amount).toEqual(usd(12));
  });

  it("says so rather than throwing when something is not there", async () => {
    const result = await client.callTool({
      name: "claim_status",
      arguments: { claim_id: "clm_nonexistent" },
    });

    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text?: string }>)[0]?.text).toContain("don't have");
  });
});
