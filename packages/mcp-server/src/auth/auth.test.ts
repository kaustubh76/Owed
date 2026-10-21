import { createHash, randomBytes } from "node:crypto";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { usd } from "@owed/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HOUSEHOLD_ID } from "../seed/storyboard.js";
import { type Harness, startHarness } from "../testing/harness.js";
import { type AuthConfig, DEFAULT_SCOPES } from "./config.js";
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
    // "per client" presupposes clients. There is no Dynamic Client Registration here —
    // `auth/config.ts` ships a static list — so no clients is not an empty starting state,
    // it is the configuration in which account linking cannot happen at all. Without this
    // line the loop below would report that configuration as passing.
    expect(harness.authConfig.clients.length, "statically registered clients").toBeGreaterThan(0);

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

/**
 * What PKCE and single-use codes are *for*.
 *
 * The flow test above proves a well-behaved client can link. It says nothing about the
 * case the mechanism exists for: an authorization code read off a redirect — out of a
 * log, a referrer, a shoulder — and presented by someone who never held the verifier.
 * `codes.test.ts` pins `verifyCodeChallenge` and `redeem` as functions; these two drive
 * the token endpoint over real HTTP, because a unit test of a predicate does not prove
 * the endpoint consults it.
 */
describe("a stolen authorization code", () => {
  it("cannot be exchanged twice", async () => {
    const { code, verifier, redirectUri, resource } = await authorize();
    const fields = {
      code,
      code_verifier: verifier,
      client_id: CLIENT_ID,
      redirect_uri: redirectUri,
      resource,
    };

    const first = await exchange(fields);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.access_token).toEqual(expect.any(String));

    // Same code, same verifier, same client: everything an interceptor would replay.
    const replay = await exchange(fields);

    expect(replay.status).toBe(400);
    expect(replay.body.error).toBe("invalid_grant");
    expect(replay.body.access_token).toBeUndefined();
  });

  it("is worthless without the verifier it was issued against", async () => {
    const { code, redirectUri, resource } = await authorize();

    // A verifier of exactly the right shape — correct length, correct alphabet — that
    // simply hashes to something else. The refusal has to come from the comparison,
    // not from a format check the attacker could satisfy.
    const guess = randomBytes(64).toString("base64url");
    const stolen = await exchange({
      code,
      code_verifier: guess,
      client_id: CLIENT_ID,
      redirect_uri: redirectUri,
      resource,
    });

    expect(stolen.status).toBe(400);
    expect(stolen.body.error).toBe("invalid_grant");
    expect(stolen.body.access_token).toBeUndefined();
  });

  /**
   * And the attempt burns the code, so the real client's own exchange fails after it.
   *
   * That is RFC 6749 §4.1.2 — a code SHOULD be revoked once an exchange fails — and in
   * `handleToken` it is an ordering property: `redeem` runs before the PKCE comparison,
   * so a wrong verifier still spends the code. The legitimate client re-links, which is
   * the right trade: the alternative leaves a known-leaked code live for five minutes.
   */
  it("is spent by the failed attempt, even for the client that earned it", async () => {
    const { code, verifier, redirectUri, resource } = await authorize();

    const stolen = await exchange({
      code,
      code_verifier: randomBytes(64).toString("base64url"),
      client_id: CLIENT_ID,
      redirect_uri: redirectUri,
      resource,
    });
    expect(stolen.status).toBe(400);

    const legitimate = await exchange({
      code,
      code_verifier: verifier,
      client_id: CLIENT_ID,
      redirect_uri: redirectUri,
      resource,
    });

    expect(legitimate.status).toBe(400);
    expect(legitimate.body.error).toBe("invalid_grant");
    expect(legitimate.body.access_token).toBeUndefined();
  });
});

/**
 * The two bindings on an access token, each checked by minting a token that differs from
 * a working one in exactly one claim.
 *
 * Both are library behaviour — `jose` enforces `exp` and `aud` inside `jwtVerify` — which
 * is the reason to test them rather than the reason not to: the product leans on them.
 * The brain's whole renewal path exists because of the first, and the second is what
 * "RFC 8707" in readme §13 names.
 */
describe("access token claims, at the gate", () => {
  const claims = {
    household_id: HOUSEHOLD_ID,
    client_id: CLIENT_ID,
    scopes: DEFAULT_SCOPES,
  };

  /** `tools/list` with this token, which is the cheapest call the gate stands in front of. */
  async function listTools(token: string): Promise<number> {
    const response = await fetch(harness.mcpUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    return response.status;
  }

  it("refuses an expired token, and accepts the same claims unexpired", async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);

    // `issueToken` adds the TTL to the instant it is handed, so an instant one TTL plus a
    // minute in the past yields a token that was valid and is not. Nothing is mocked.
    const stale = await issueToken(
      harness.authConfig,
      "access",
      claims,
      nowSeconds - harness.authConfig.accessTokenTtlSeconds - 60,
    );
    const fresh = await issueToken(harness.authConfig, "access", claims, nowSeconds);

    expect(await listTools(stale.token)).toBe(401);
    // The pair is the point: without this line the test passes against a gate that
    // refuses every token, which is not the property being claimed.
    expect(await listTools(fresh.token)).toBe(200);
  });

  it("refuses a token minted for another resource, signed with this server's own key", async () => {
    const elsewhere: AuthConfig = {
      ...harness.authConfig,
      resource: new URL("https://someone-elses-mcp.example/mcp"),
    };

    // Stated so the refusal cannot be mistaken for a signature failure: same secret,
    // same issuer, same kind. The audience is the only claim that differs.
    expect(elsewhere.secret).toBe(harness.authConfig.secret);
    expect(elsewhere.issuer.href).toBe(harness.authConfig.issuer.href);
    expect(elsewhere.resource.href).not.toBe(harness.authConfig.resource.href);

    const foreign = await issueToken(elsewhere, "access", claims, Math.floor(Date.now() / 1000));

    expect(await listTools(foreign.token)).toBe(401);
  });

  /**
   * A refresh token is not an access token, however well signed.
   *
   * The two are the same shape and the same key, separated only by the `kind` claim —
   * so the long-lived one must not open the gate the short-lived one guards.
   */
  it("refuses a refresh token presented as an access token", async () => {
    const refresh = await issueToken(
      harness.authConfig,
      "refresh",
      claims,
      Math.floor(Date.now() / 1000),
    );

    expect(await listTools(refresh.token)).toBe(401);
  });
});

const CLIENT_ID = "owed-simulated-home";

/**
 * Walk discovery and consent by hand, and stop where an interceptor would: holding the
 * code, and in the tests above sometimes not holding the verifier hashed into it.
 *
 * `linkAccount` walks the same two steps and then exchanges them, which is the path the
 * flow test and the demo cover. The halfway state is repeated here rather than lifted out
 * of the production helper, because a test that reused `linkAccount` could only assert
 * against exchanges that helper is willing to make.
 */
async function authorize(): Promise<{
  code: string;
  verifier: string;
  redirectUri: string;
  resource: string;
}> {
  const redirectUri = "http://127.0.0.1:8765/callback";
  const verifier = randomBytes(64).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");

  const discovery = await fetch(new URL("/.well-known/oauth-protected-resource", harness.baseUrl));
  const { resource } = (await discovery.json()) as { resource: string };

  const consent = await fetch(new URL("/oauth/authorize", harness.baseUrl), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      response_type: "code",
      client_id: CLIENT_ID,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource,
      decision: "allow",
    }),
    redirect: "manual",
  });

  const location = consent.headers.get("location");
  if (location === null) throw new Error(`consent did not redirect (status ${consent.status})`);
  const code = new URL(location).searchParams.get("code");
  if (code === null) throw new Error(`consent redirected without a code: ${location}`);

  return { code, verifier, redirectUri, resource };
}

/** POST the token endpoint as a form, the way a client does, and read the OAuth body back. */
async function exchange(
  fields: Record<string, string>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(new URL("/oauth/token", harness.baseUrl), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", ...fields }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

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
