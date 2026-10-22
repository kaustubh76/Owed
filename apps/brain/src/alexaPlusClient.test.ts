import { type Harness, startHarness } from "@owed/mcp-server";
import {
  linkAccount as alexaPlusLinksAnAccount,
  callTool,
  connectMcp,
  discoverAuthorizationServer,
  discoverProtectedResource,
  isAppCallable,
  type McpSession,
  readUiResource,
  registerDynamicClient,
  resolveUiForTurn,
  type ToolCallTrace,
  uiResourceUri,
  uiVisibility,
} from "mcp-voice-simulator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The add-on driven by a client nobody here wrote.
 *
 * Every other test in this repository is Owed's own client talking to Owed's own server. That
 * proves the two agree; it cannot prove either is *right*, because one author's
 * misreading of a spec is invisible to both halves. `apps/brain` is Owed's Alexa+ stand-in,
 * and it was written against the same documents as the server it calls.
 *
 * `mcp-voice-simulator` is a third party's clean-room Alexa+ client — unaffiliated with Amazon
 * and with this project, built from MCP's Streamable HTTP transport, OAuth 2.1, PKCE, RFC 9728,
 * RFC 8414 and RFC 7591. The repository already spawns its conformance binary in `pnpm
 * conformance`; this drives its *client library* through the sequence a real integration
 * performs: discover, link, list, call, render. Nothing here is mocked and nothing is stubbed —
 * the harness is the real app on a real port, and the OAuth flow is the real one.
 *
 * **What it found.** Owed declared no `_meta.ui.visibility`, and MCP Apps' published default is
 * `["model", "app"]` — so a sandboxed view could call every tool, `claim_file` included. Owed's
 * own host cannot make that call (`EchoShow.tsx` passes a null client, so the SDK never wires
 * `oncalltool`), which is exactly why no test in this repository could see it. An independent
 * host could. See `MODEL_ONLY` in `packages/mcp-server/src/views.ts` and amendment D26.
 *
 * **What it is not.** Still not Alexa+. This is a second reading of the same public documents,
 * which is worth a great deal more than one reading and is not the same as the real client.
 * §13 of the readme says so and continues to.
 */

/** The human's part of account linking is done by `consent()` below, so this is generous. */
const LINK_TIMEOUT_MS = 20_000;

/** Boot, link, connect, six tools, three view documents of ~460 KB each. */
const GRACE_MS = 15_000;

/** The storyboard's figure, as the household hears it rather than as JSON. */
const RECOVERED_SPOKEN = "forty-seven dollars";

const EXPECTED_TOOLS = [
  "claim_file",
  "claim_status",
  "evidence_get",
  "ledger_summary",
  "promise_check",
  "promises_list",
] as const;

const EXPECTED_VIEWS: Readonly<Record<string, string>> = {
  ledger_summary: "ui://owed/ledger",
  promises_list: "ui://owed/ledger",
  promise_check: "ui://owed/evidence",
  evidence_get: "ui://owed/evidence",
  claim_status: "ui://owed/claim",
  claim_file: "ui://owed/claim",
};

/**
 * Stand in for the person at the browser, over HTTP.
 *
 * `linkAccount` builds the authorize URL, prints it through `onAuthorizeUrl` and waits on its
 * own loopback listener. A human would open it, see Owed's consent page and press Allow; this
 * posts the same form and then fetches the redirect, which is what delivers the code to that
 * listener. The PKCE verifier never leaves the simulator, so the token exchange still has to
 * succeed on its own terms — this only replaces the hands.
 */
async function consent(authorizeUrl: string): Promise<void> {
  const url = new URL(authorizeUrl);
  const body = new URLSearchParams(url.searchParams);
  body.set("decision", "allow");

  const posted = await fetch(url.origin + url.pathname, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    redirect: "manual",
  });
  const location = posted.headers.get("location");
  if (location === null) {
    throw new Error(`Owed's consent page did not redirect (status ${posted.status})`);
  }
  await fetch(location);
}

describe("the add-on, driven by a third party's Alexa+ client", {
  timeout: LINK_TIMEOUT_MS + GRACE_MS,
}, () => {
  let harness: Harness;
  let session: McpSession;
  let linkedClientId: string;
  let issuer: string;
  let authorizationServer: Record<string, unknown>;
  let protectedResource: Record<string, unknown>;
  let dynamicRegistration: string | undefined;
  let trace: ToolCallTrace;

  beforeAll(async () => {
    harness = await startHarness();

    protectedResource = (await discoverProtectedResource(harness.mcpUrl.href)) as Record<
      string,
      unknown
    >;
    // Named rather than asserted non-null: if discovery returns no authorization server the
    // whole premise of this file is gone, and the message should say that.
    const [advertised] = (protectedResource.authorization_servers as string[] | undefined) ?? [];
    if (advertised === undefined) {
      throw new Error("Owed's RFC 9728 metadata named no authorization server");
    }
    issuer = advertised;
    authorizationServer = (await discoverAuthorizationServer(issuer)) as Record<string, unknown>;

    // A redirect this client never intends to use: the call is here to read the metadata, and
    // Owed advertises no `registration_endpoint`, so it must come back empty rather than throw.
    dynamicRegistration = await registerDynamicClient(
      authorizationServer as never,
      "http://127.0.0.1:1/callback",
    );

    let consentFailure: unknown;
    const linked = await alexaPlusLinksAnAccount({
      mcpUrl: harness.mcpUrl.href,
      // Owed registers this client id for the three regional Amazon link hosts plus loopback.
      clientId: "alexa-plus",
      timeoutMs: LINK_TIMEOUT_MS,
      onAuthorizeUrl: (url) => {
        void consent(url).catch((cause) => {
          consentFailure = cause;
        });
      },
    }).catch((cause) => {
      throw consentFailure ?? cause;
    });
    if (consentFailure !== undefined) throw consentFailure;

    linkedClientId = linked.clientId;
    session = await connectMcp(harness.mcpUrl.href, linked.accessToken, { ui: true });
    trace = await callTool(session, "ledger_summary", {});
  }, LINK_TIMEOUT_MS + GRACE_MS);

  afterAll(async () => {
    await session?.client.close();
    await harness?.close();
  });

  it("discovers which authorization server protects it (RFC 9728)", () => {
    expect(protectedResource.resource).toBe(harness.mcpUrl.href);
    expect(protectedResource.authorization_servers).toContain(
      harness.baseUrl.href.replace(/\/$/, ""),
    );
  });

  it("and the endpoints and grants that server offers (RFC 8414)", () => {
    expect(String(authorizationServer.authorization_endpoint)).toContain(harness.baseUrl.host);
    expect(String(authorizationServer.token_endpoint)).toContain(harness.baseUrl.host);
    expect(authorizationServer.code_challenge_methods_supported).toStrictEqual(["S256"]);
    // Amendment D25, read back by somebody else: the two grants a household's add-on uses, and
    // no `client_credentials`, which once let a bare client id read the whole ledger.
    expect(authorizationServer.grant_types_supported).toStrictEqual([
      "authorization_code",
      "refresh_token",
    ]);
  });

  it("finds no dynamic client registration, which is the documented choice", () => {
    expect(dynamicRegistration).toBeUndefined();
    expect(authorizationServer.registration_endpoint).toBeUndefined();
  });

  it("links an account the way the real client would — OAuth 2.1, PKCE, loopback", () => {
    expect(linkedClientId).toBe("alexa-plus");
    expect(session.client).toBeDefined();
  });

  it("discovers the whole frozen tool surface", () => {
    expect(session.tools.map((tool) => tool.name).sort()).toStrictEqual([...EXPECTED_TOOLS]);
  });

  it("is told this host can render views, and which view each tool draws", () => {
    expect(session.ui, "the client advertised MCP Apps support and the server accepted").toBe(true);
    const declared = Object.fromEntries(
      session.tools.map((tool) => [tool.name, uiResourceUri(tool)]),
    );
    expect(declared).toStrictEqual(EXPECTED_VIEWS);
    expect(new Set(Object.values(declared)).size, "distinct views").toBe(3);
  });

  /**
   * The finding this file exists for, asserted by the other party's reader.
   *
   * `isAppCallable` is the third party's implementation of the spec rule — a host MUST refuse a
   * view's `tools/call` unless the tool's visibility includes "app". Before `MODEL_ONLY` it
   * returned true for all six, `claim_file` among them.
   */
  it("tells any host that no tool may be called from inside a view", () => {
    const reachableFromAView = session.tools.filter(isAppCallable).map((tool) => tool.name);
    expect(reachableFromAView, "callable by sandboxed view HTML").toStrictEqual([]);

    for (const tool of session.tools) {
      expect(uiVisibility(tool), `${tool.name} visibility`).toStrictEqual(["model"]);
    }
  });

  it("answers a tool call with exactly one block, and it is speech", () => {
    expect(trace.isError).toBe(false);
    const blocks = (trace.result?.content ?? []) as { type: string; text?: string }[];
    expect(blocks.map((block) => block.type)).toStrictEqual(["text"]);

    const spoken = String(blocks[0]?.text ?? "");
    expect(spoken).toContain(RECOVERED_SPOKEN);
    expect(spoken, "a URI reached the spoken line").not.toMatch(/ui:\/\/|https?:\/\//);
    expect(spoken, "raw JSON reached the spoken line").not.toMatch(/[{}[\]]/);
  });

  it("serves every view as a self-contained MCP Apps document under a closed CSP", async () => {
    for (const uri of new Set(Object.values(EXPECTED_VIEWS))) {
      // Throws, by their code, on the wrong MIME type or empty content.
      const view = await readUiResource(session, uri);
      expect(view.html.length, `${uri} html`).toBeGreaterThan(1_000);
      expect(view.html, `${uri} is a document`).toMatch(/<html/i);

      // Deny-by-default: the view declares no network and no foreign assets of any kind.
      expect(
        {
          connect: view.csp.connectDomains ?? [],
          resource: view.csp.resourceDomains ?? [],
          frame: view.csp.frameDomains ?? [],
          baseUri: view.csp.baseUriDomains ?? [],
        },
        `${uri} csp`,
      ).toStrictEqual({ connect: [], resource: [], frame: [], baseUri: [] });
      expect(view.permissions, `${uri} asks for no device permission`).toStrictEqual({});
    }
  });

  it("resolves the turn to the one card that spoken line belongs to", async () => {
    const resolved = await resolveUiForTurn(session, [trace], "test");
    expect(resolved.warnings).toStrictEqual([]);
    expect(resolved.ui?.resourceUri).toBe(EXPECTED_VIEWS.ledger_summary);
    expect(resolved.ui?.tool).toBe("ledger_summary");
    expect(resolved.ui?.toolResult).toBeDefined();
  });
});
