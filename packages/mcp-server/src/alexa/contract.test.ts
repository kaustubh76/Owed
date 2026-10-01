import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as z from "zod/v4";
import { type Harness, startHarness } from "../testing/harness.js";
import { CONFIRMATION_SCHEMA } from "../tools/claimFile.js";
import { MAX_SPOKEN_CHARS } from "../voice.js";

/**
 * The Alexa+ add-on contract, asserted.
 *
 * `mcp-voice-simulator-conformance` checks four things, all about OAuth discovery. Amazon
 * documents a good deal more than that, and none of it was covered until this file: that
 * every advertised tool is invocable, that answers arrive inside the documented latency
 * target, that nothing internal is ever spoken aloud, and that each view is the
 * self-contained document a sandboxed iframe can actually render.
 *
 * **What this does not do.** Alexa+ for Builders is partner-gated, so none of this runs
 * against the real client. It tests against the *documented* contract. "Contract suite
 * green" must never be read as "works on Alexa+".
 */
let harness: Harness;
let token: string;
let client: Client;

/** Arguments that exercise each tool without changing anything. */
const MINIMAL_ARGS: Readonly<Record<string, Record<string, unknown>>> = {
  ledger_summary: {},
  promises_list: {},
  promise_check: { promise_id: "prm_002" },
  claim_status: { claim_id: "clm_002" },
  // Already filed, so this reports rather than writes.
  claim_file: { promise_id: "prm_002" },
};

async function connect(
  capabilities: Record<string, unknown> = {},
  modern = false,
): Promise<Client> {
  const connected = new Client(
    { name: "alexa-contract", version: "1.0.0" },
    { capabilities, ...(modern ? { versionNegotiation: { mode: "auto" as const } } : {}) },
  );
  await connected.connect(
    new StreamableHTTPClientTransport(harness.mcpUrl, {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  return connected;
}

beforeAll(async () => {
  harness = await startHarness();
  token = await harness.link();
  client = await connect();
});

afterAll(async () => {
  await client?.close();
  await harness?.close();
});

/**
 * A ledger of its own.
 *
 * Filing changes state, so a test that files must not decide what the next one sees.
 */
async function freshClient(capabilities: Record<string, unknown>, modern = false) {
  const own = await startHarness();
  const ownToken = await own.link();
  const connected = new Client(
    { name: "alexa-contract", version: "1.0.0" },
    { capabilities, ...(modern ? { versionNegotiation: { mode: "auto" as const } } : {}) },
  );
  await connected.connect(
    new StreamableHTTPClientTransport(own.mcpUrl, {
      requestInit: { headers: { authorization: `Bearer ${ownToken}` } },
    }),
  );
  return {
    client: connected,
    close: async () => {
      await connected.close();
      await own.close();
    },
  };
}

const spokenOf = (result: { content: unknown }) =>
  (result.content as Array<{ type?: string; text?: string }>)[0]?.text ?? "";

async function argumentsFor(name: string): Promise<Record<string, unknown>> {
  if (name !== "evidence_get") return MINIMAL_ARGS[name] ?? {};
  // Needs a real identifier, so take one the ledger actually holds.
  const check = await client.callTool({
    name: "promise_check",
    arguments: { promise_id: "prm_002" },
  });
  const items = (check.structuredContent as { items?: Array<{ evidence_id: string }> }).items ?? [];
  return { promise_id: "prm_002", evidence_id: items[0]?.evidence_id ?? "evd_missing" };
}

describe("every advertised tool is real", () => {
  /** Amazon: no dead, placeholder or non-functional entries in `tools/list`. */
  it("answers every tool it advertises", async () => {
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(0);

    for (const tool of tools) {
      const result = await client.callTool({
        name: tool.name,
        arguments: await argumentsFor(tool.name),
      });
      expect(result.isError ?? false, `${tool.name} failed`).toBe(false);
      expect(spokenOf(result).length, `${tool.name} said nothing`).toBeGreaterThan(0);
    }
  });

  it("gives every tool a description a model could route on", async () => {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      expect((tool.description ?? "").length, tool.name).toBeGreaterThan(40);
    }
  });
});

describe("what the household hears", () => {
  async function everySpokenLine(): Promise<Array<{ tool: string; spoken: string }>> {
    const { tools } = await client.listTools();
    return Promise.all(
      tools.map(async (tool) => ({
        tool: tool.name,
        spoken: spokenOf(
          await client.callTool({ name: tool.name, arguments: await argumentsFor(tool.name) }),
        ),
      })),
    );
  }

  it("says exactly one thing, and says it inside the spoken limit", async () => {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      const result = await client.callTool({
        name: tool.name,
        arguments: await argumentsFor(tool.name),
      });
      const content = result.content as Array<{ type: string }>;
      expect(content, tool.name).toHaveLength(1);
      expect(content[0]?.type).toBe("text");
      expect(spokenOf(result).length, tool.name).toBeLessThanOrEqual(MAX_SPOKEN_CHARS);
    }
  });

  /**
   * Amazon, verbatim: surface no API codes, tool names, JSON or internal IDs in any
   * customer-facing response. Believed true here for months; never checked until now.
   */
  it("never speaks an identifier, a tool name, JSON or a URL", async () => {
    for (const { tool, spoken } of await everySpokenLine()) {
      expect(spoken, `${tool} spoke an internal id`).not.toMatch(/\b(prm|clm|evd|brc|evt)_/);
      expect(spoken, `${tool} spoke a tool name`).not.toMatch(
        /\b(ledger_summary|promises_list|promise_check|evidence_get|claim_status|claim_file)\b/,
      );
      expect(spoken, `${tool} spoke JSON`).not.toMatch(/[{}[\]]/);
      expect(spoken, `${tool} spoke a URL`).not.toMatch(/https?:\/\/|ui:\/\//);
      expect(spoken, `${tool} spoke digits`).not.toMatch(/[0-9]/);
    }
  });
});

describe("latency", () => {
  /**
   * Amazon documents a round-trip target under 500 ms.
   *
   * This is a benchmark living in a parallel test suite, which makes it the one test here
   * whose result depends on the machine rather than the code. Vitest runs a worker per file
   * and this repo now has thirty of them, each booting a server; measured on an idle laptop
   * p95 is ~5–50 ms, and measured while the rest of the suite competes for CPU it has been
   * seen at ~2000 ms. Nothing about the server changed between those two numbers.
   *
   * So: a generous timeout for the forty-call loop, and `retry`. Retrying a *measurement*
   * is legitimate — the quantity is genuinely noisy and the retry re-measures it. Retrying
   * a correctness test would not be, because a wrong answer does not become right on the
   * second ask, and nothing else in this suite is allowed one.
   *
   * The threshold itself is untouched at 500 ms: a real regression fails all three attempts.
   * The numbers quoted in the README were taken on an idle machine and should be read that
   * way.
   */
  it("answers well inside the documented target at p95", {
    timeout: 60_000,
    retry: 2,
  }, async () => {
    const samples: number[] = [];
    for (let i = 0; i < 40; i += 1) {
      const started = performance.now();
      await client.callTool({ name: "ledger_summary", arguments: {} });
      samples.push(performance.now() - started);
    }

    samples.sort((a, b) => a - b);
    const p95 = samples[Math.floor(samples.length * 0.95)] ?? 0;
    process.stdout.write(`    ledger_summary p95: ${p95.toFixed(1)} ms\n`);

    expect(p95).toBeLessThan(500);
  });
});

describe("the views a sandboxed iframe has to render", () => {
  async function everyViewUri(): Promise<string[]> {
    const { tools } = await client.listTools();
    const uris = tools
      .map((tool) => (tool._meta as { ui?: { resourceUri?: string } } | undefined)?.ui?.resourceUri)
      .filter((uri): uri is string => typeof uri === "string");
    return [...new Set(uris)];
  }

  it("serves every view a tool points at", async () => {
    for (const uri of await everyViewUri()) {
      const resource = await client.readResource({ uri });
      const [content] = resource.contents as Array<{ mimeType?: string; text?: string }>;
      expect(content?.mimeType, uri).toBe(RESOURCE_MIME_TYPE);
      expect((content?.text ?? "").length, uri).toBeGreaterThan(0);
    }
  });

  /** One document. A sandboxed iframe cannot go and fetch the rest of it. */
  it("ships each view self-contained, with nothing to fetch", async () => {
    for (const uri of await everyViewUri()) {
      const resource = await client.readResource({ uri });
      const html = (resource.contents as Array<{ text?: string }>)[0]?.text ?? "";
      expect(html, uri).not.toMatch(/<script[^>]+src=["']https?:/i);
      expect(html, uri).not.toMatch(/<link[^>]+href=["']https?:/i);
      expect(html, uri).not.toMatch(/<img[^>]+src=["']https?:/i);
    }
  });

  it("declares a deny-by-default content security policy on every view", async () => {
    for (const uri of await everyViewUri()) {
      const resource = await client.readResource({ uri });
      const meta = (resource.contents as Array<{ _meta?: { ui?: { csp?: unknown } } }>)[0]?._meta;
      const csp = meta?.ui?.csp as
        | { resourceDomains?: string[]; connectDomains?: string[] }
        | undefined;

      expect(csp, `${uri} declares no CSP`).toBeDefined();
      expect(csp?.resourceDomains, uri).toEqual([]);
      expect(csp?.connectDomains, uri).toEqual([]);
    }
  });
});

describe("elicitation", () => {
  /** MCP form mode allows a flat object of primitives and nothing else. */
  it("asks with a flat object of primitives, as form mode requires", () => {
    expect(CONFIRMATION_SCHEMA.type).toBe("object");
    for (const [name, property] of Object.entries(CONFIRMATION_SCHEMA.properties)) {
      expect(["boolean", "string", "number", "integer"], name).toContain(property.type);
      expect(property, name).not.toHaveProperty("properties");
      expect(property, name).not.toHaveProperty("items");
    }
  });

  it("asks both of the questions the product promised, in one round", () => {
    expect(Object.keys(CONFIRMATION_SCHEMA.properties)).toEqual(["confirm", "attach_evidence"]);
    expect(CONFIRMATION_SCHEMA.required).toEqual(["confirm"]);
  });

  /**
   * The round trip, not just the request: the household is asked, answers, and the claim
   * is filed as a result of the answer.
   *
   * On a 2026-07-28 connection the question rides in the result and the client retries,
   * which works on stateless serving. The 2025 revision needs a session for a
   * server-to-client request and per-request serving cannot make one — covered below.
   */
  it("asks, and files only once the household has answered", async () => {
    const { client: asking, close } = await freshClient({ elicitation: {} }, true);
    const questions: string[] = [];

    asking.setRequestHandler(
      "elicitation/create",
      { params: z.object({ message: z.string() }).catchall(z.unknown()) },
      (params) => {
        questions.push(params.message);
        return { action: "accept", content: { confirm: true, attach_evidence: true } };
      },
    );

    try {
      const result = await asking.callTool({
        name: "claim_file",
        arguments: { promise_id: "prm_011" },
      });

      expect(questions, "the household was never asked").toHaveLength(1);
      expect(questions[0]).toContain("Shall I file it?");
      expect((result.structuredContent as { state?: string }).state).toBe("Settled");
    } finally {
      await close();
    }
  });

  /**
   * The constraint, asserted rather than assumed. A 2025-era connection served
   * per-request cannot be asked anything, so the tool proposes in words instead of
   * failing — which is why `confirm` exists.
   */
  it("proposes in words where the connection cannot carry a question", async () => {
    const { client: plain, close } = await freshClient({ elicitation: {} });

    try {
      const result = await plain.callTool({
        name: "claim_file",
        arguments: { promise_id: "prm_011" },
      });

      expect(result.isError ?? false).toBe(false);
      expect((result.structuredContent as { state?: string }).state).toBe("Proposed");
      expect(spokenOf(result)).toContain("Shall I file it");
    } finally {
      await close();
    }
  });

  it("does not file when the household says no", async () => {
    const { client: refusing, close } = await freshClient({ elicitation: {} }, true);
    refusing.setRequestHandler(
      "elicitation/create",
      { params: z.object({ message: z.string() }).catchall(z.unknown()) },
      () => ({ action: "decline" }),
    );

    try {
      const result = await refusing.callTool({
        name: "claim_file",
        arguments: { promise_id: "prm_011" },
      });
      expect(result.isError).toBe(true);
      expect(spokenOf(result)).toContain("won't file it");
    } finally {
      await close();
    }
  });
});
