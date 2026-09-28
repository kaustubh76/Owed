import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { usd } from "@owed/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Harness, startHarness } from "../testing/harness.js";
import { issueToken } from "./tokens.js";

let harness: Harness;

beforeAll(async () => {
  harness = await startHarness();
});

afterAll(async () => {
  await harness.close();
});

const json = async (path: string) => {
  const response = await fetch(new URL(path, harness.baseUrl));
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};

/**
 * The four assertions `mcp-voice-simulator-conformance` actually binds on, asserted
 * here so they are green in CI rather than only when someone remembers to run the CLI.
 * Two of the four hinge entirely on RFC 9728 discovery working.
 */
describe("Alexa+ conformance gates", () => {
  it("answers ping without a server error", async () => {
    const response = await fetch(harness.mcpUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });

    expect(response.status).toBeLessThan(500);
  });

  it("answers exactly 401 to an unauthenticated tools/list", async () => {
    // Deliberately no `Accept` header — this is what the checker sends, and a server
    // that validated Accept before auth would answer 406 and fail the gate.
    const response = await fetch(harness.mcpUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });

    expect(response.status).toBe(401);
  });

  it("sends no WWW-Authenticate challenge", async () => {
    const response = await fetch(harness.mcpUrl, { method: "POST" });

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBeNull();
  });

  it("advertises PKCE S256 and the authorization code grant", async () => {
    const { body } = await json("/.well-known/oauth-authorization-server");

    expect(body.code_challenge_methods_supported).toContain("S256");
    expect(body.grant_types_supported).toContain("authorization_code");
  });
});

describe("discovery documents", () => {
  it("serves protected resource metadata naming an authorization server", async () => {
    const { status, body } = await json("/.well-known/oauth-protected-resource");

    expect(status).toBe(200);
    expect(Array.isArray(body.authorization_servers)).toBe(true);
    expect((body.authorization_servers as string[])[0]).toBe(
      harness.authConfig.issuer.href.replace(/\/$/, ""),
    );
    expect(body.resource).toBe(harness.authConfig.resource.href);
  });

  it("also serves it at the path-aware location", async () => {
    const { status, body } = await json("/.well-known/oauth-protected-resource/mcp");

    expect(status).toBe(200);
    expect(body.resource).toBe(harness.authConfig.resource.href);
  });

  it("does not advertise dynamic client registration, which Alexa+ does not support", async () => {
    const { body } = await json("/.well-known/oauth-authorization-server");

    expect(body.registration_endpoint).toBeUndefined();
  });

  it("registers several redirect URIs per client, so linking works across regions", () => {
    for (const client of harness.authConfig.clients) {
      expect(client.redirect_uris.length).toBeGreaterThan(1);
    }
  });
});

describe("account linking", () => {
  it("completes authorization code + PKCE and returns a usable token", async () => {
    const token = await harness.link();

    const response = await fetch(harness.mcpUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });

    expect(response.status).toBe(200);
  });

  it("issues a refresh token that outlives the access token by a wide margin", async () => {
    expect(harness.authConfig.refreshTokenTtlSeconds).toBeGreaterThanOrEqual(180 * 24 * 60 * 60);
    expect(harness.authConfig.refreshTokenTtlSeconds).toBeGreaterThan(
      harness.authConfig.accessTokenTtlSeconds * 100,
    );
  });

  it("exchanges a refresh token for a fresh access token", async () => {
    const link = await fetch(new URL("/.well-known/oauth-protected-resource", harness.baseUrl));
    expect(link.ok).toBe(true);

    const { linkAccount } = await import("./link.js");
    const first = await linkAccount({ baseUrl: harness.baseUrl, clientId: "owed-simulated-home" });

    const refreshed = await fetch(new URL("/oauth/token", harness.baseUrl), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: first.refreshToken,
        client_id: "owed-simulated-home",
      }),
    });

    expect(refreshed.status).toBe(200);
    expect(((await refreshed.json()) as { access_token?: unknown }).access_token).toEqual(
      expect.any(String),
    );
  });

  it("rejects an unknown client rather than inventing one", async () => {
    const response = await fetch(
      new URL("/oauth/authorize?response_type=code&client_id=nobody", harness.baseUrl),
    );

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error?: unknown }).error).toBe("invalid_client");
  });

  it("refuses a code challenge method other than S256", async () => {
    const params = new URLSearchParams({
      response_type: "code",
      client_id: "owed-simulated-home",
      redirect_uri: "http://127.0.0.1:8765/callback",
      code_challenge: "x".repeat(43),
      code_challenge_method: "plain",
    });
    const response = await fetch(new URL(`/oauth/authorize?${params}`, harness.baseUrl), {
      redirect: "manual",
    });

    expect(response.headers.get("location")).toContain("error=invalid_request");
  });

  it("refuses a redirect URI that was never registered", async () => {
    const params = new URLSearchParams({
      response_type: "code",
      client_id: "owed-simulated-home",
      redirect_uri: "https://attacker.example/callback",
    });
    const response = await fetch(new URL(`/oauth/authorize?${params}`, harness.baseUrl));

    expect(response.status).toBe(400);
  });
});

describe("token binding", () => {
  it("rejects a token this server did not issue", async () => {
    const response = await fetch(harness.mcpUrl, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer not-a-token" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });

    expect(response.status).toBe(401);
  });

  /**
   * The ledger a tool reads comes from the household in the token, never from server
   * configuration. A token for another household must see nothing at all.
   */
  it("scopes the ledger to the household named in the token", async () => {
    const stranger = await issueToken(
      harness.authConfig,
      "access",
      { household_id: "hh_someone_else", client_id: "owed-simulated-home", scopes: ["owed.read"] },
      Math.floor(Date.now() / 1000),
    );

    const mine = await callSummary(await harness.link());
    const theirs = await callSummary(stranger.token);

    expect(mine.recovered).toEqual(usd(47));
    expect(theirs.recovered).toEqual(usd(0));
    expect(theirs.items).toHaveLength(0);
  });
});

async function callSummary(token: string) {
  const client = new Client({ name: "auth-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(harness.mcpUrl, {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  try {
    const result = await client.callTool({ name: "ledger_summary", arguments: {} });
    return result.structuredContent as { recovered: unknown; items: unknown[] };
  } finally {
    await client.close();
  }
}
