import type { Clock } from "@owed/core";
import { toEpochMs } from "@owed/domain";
import express, { type Request, type Response, Router } from "express";
import { AuthorizationCodeStore, verifyCodeChallenge } from "./codes.js";
import { type AuthConfig, findClient, isRedirectAllowed } from "./config.js";
import { authorizationServerMetadata, protectedResourceMetadata } from "./metadata.js";
import { issueToken, verifyToken } from "./tokens.js";

export interface AuthRouterOptions {
  config: AuthConfig;
  clock: Clock;
  /** The household a successful sign-in resolves to. */
  householdId: string;
  codes?: AuthorizationCodeStore;
}

function oauthError(res: Response, status: number, error: string, description: string): void {
  res.status(status).json({ error, error_description: description });
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char,
  );
}

function first(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return undefined;
}

interface AuthorizeRequest {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  state: string | undefined;
  scopes: string[];
  resource: string;
}

/**
 * Validate an authorization request, or answer it.
 *
 * Errors before `redirect_uri` is known must be shown to the person, never redirected —
 * redirecting to an unvalidated URI is an open redirect.
 */
function parseAuthorizeRequest(
  config: AuthConfig,
  params: Record<string, unknown>,
  res: Response,
): AuthorizeRequest | undefined {
  const clientId = first(params.client_id);
  const redirectUri = first(params.redirect_uri);

  const client = clientId === undefined ? undefined : findClient(config, clientId);
  if (!client || clientId === undefined) {
    oauthError(
      res,
      400,
      "invalid_client",
      "Unknown client_id. This server uses static client registration.",
    );
    return undefined;
  }
  if (redirectUri === undefined || !isRedirectAllowed(client, redirectUri)) {
    oauthError(res, 400, "invalid_request", "redirect_uri is not registered for this client.");
    return undefined;
  }

  const state = first(params.state);
  const fail = (error: string, description: string) => {
    const target = new URL(redirectUri);
    target.searchParams.set("error", error);
    target.searchParams.set("error_description", description);
    if (state !== undefined) target.searchParams.set("state", state);
    res.redirect(target.href);
  };

  if (first(params.response_type) !== "code") {
    fail("unsupported_response_type", "Only the authorization code flow is supported.");
    return undefined;
  }
  if (first(params.code_challenge_method) !== "S256") {
    fail("invalid_request", "PKCE with S256 is required.");
    return undefined;
  }

  const codeChallenge = first(params.code_challenge);
  if (codeChallenge === undefined || codeChallenge.length < 43) {
    fail("invalid_request", "A valid S256 code_challenge is required.");
    return undefined;
  }

  // RFC 8707: Amazon requires `resource` on both the authorization and token requests.
  const resource = first(params.resource) ?? config.resource.href;
  if (new URL(resource).href !== config.resource.href) {
    fail("invalid_target", "resource does not name this MCP server.");
    return undefined;
  }

  const requested = (first(params.scope) ?? client.scopes.join(" ")).split(" ").filter(Boolean);
  const granted = requested.filter((scope) => client.scopes.includes(scope));
  if (granted.length === 0) {
    fail("invalid_scope", "None of the requested scopes are available to this client.");
    return undefined;
  }

  return {
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: codeChallenge,
    state,
    scopes: granted,
    resource,
  };
}

function consentPage(request: AuthorizeRequest, householdId: string): string {
  const hidden = Object.entries({
    response_type: "code",
    client_id: request.client_id,
    redirect_uri: request.redirect_uri,
    code_challenge: request.code_challenge,
    code_challenge_method: "S256",
    scope: request.scopes.join(" "),
    resource: request.resource,
    ...(request.state === undefined ? {} : { state: request.state }),
  })
    .map(([name, value]) => `<input type="hidden" name="${name}" value="${escapeHtml(value)}" />`)
    .join("\n      ");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Link Owed</title>
  <style>
    body { margin:0; min-height:100vh; display:grid; place-items:center;
           background:#0b0e13; color:#eef1f6;
           font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif; }
    .card { width:min(440px,92vw); padding:28px; border:1px solid #232a35;
            border-radius:14px; background:#12161d; }
    h1 { margin:0 0 6px; font-size:20px; }
    p { margin:0 0 18px; color:#98a2b3; font-size:14px; }
    ul { margin:0 0 22px; padding-left:18px; color:#eef1f6; font-size:14px; }
    button { min-height:48px; width:100%; border:0; border-radius:12px;
             background:#2d415e; color:#fff; font:inherit; cursor:pointer; }
    .deny { margin-top:10px; background:transparent; border:1px solid #232a35; color:#98a2b3; }
  </style>
</head>
<body>
  <main class="card">
    <h1>Link Owed to ${escapeHtml(request.client_id)}</h1>
    <p>Owed will act for household <strong>${escapeHtml(householdId)}</strong>.</p>
    <ul>
      <li>Read the promises and claims in your ledger</li>
      <li>File a claim only when you say so</li>
    </ul>
    <form method="post" action="/oauth/authorize">
      ${hidden}
      <button type="submit" name="decision" value="allow">Allow</button>
      <button type="submit" name="decision" value="deny" class="deny">Not now</button>
    </form>
  </main>
</body>
</html>`;
}

export function createAuthRouter(options: AuthRouterOptions): Router {
  const { config, clock, householdId } = options;
  const codes = options.codes ?? new AuthorizationCodeStore();
  const router = Router();
  const form = express.urlencoded({ extended: false });

  const nowMs = () => toEpochMs(clock.now());
  const nowSeconds = () => Math.floor(nowMs() / 1000);

  // --- discovery -----------------------------------------------------------
  // Amazon's own pages disagree about which document lives at which path, so both
  // are served at both shapes. The path-aware form is what RFC 9728 specifies for a
  // resource served under a path, and what the 401 challenge would point at.
  const prm = (_req: Request, res: Response) => res.json(protectedResourceMetadata(config));
  router.get("/.well-known/oauth-protected-resource", prm);
  router.get("/.well-known/oauth-protected-resource/mcp", prm);

  router.get("/.well-known/oauth-authorization-server", (_req, res) => {
    res.json(authorizationServerMetadata(config));
  });
  router.get("/.well-known/oauth-authorization-server/mcp", (_req, res) => {
    res.json(authorizationServerMetadata(config));
  });

  // --- authorization -------------------------------------------------------
  router.get("/oauth/authorize", (req: Request, res: Response) => {
    const request = parseAuthorizeRequest(config, req.query as Record<string, unknown>, res);
    if (!request) return;
    res.type("html").send(consentPage(request, householdId));
  });

  router.post("/oauth/authorize", form, (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const request = parseAuthorizeRequest(config, body, res);
    if (!request) return;

    const target = new URL(request.redirect_uri);
    if (request.state !== undefined) target.searchParams.set("state", request.state);

    if (first(body.decision) !== "allow") {
      target.searchParams.set("error", "access_denied");
      res.redirect(target.href);
      return;
    }

    const code = codes.issue(
      {
        client_id: request.client_id,
        redirect_uri: request.redirect_uri,
        household_id: householdId,
        scopes: request.scopes,
        code_challenge: request.code_challenge,
        resource: request.resource,
      },
      nowMs(),
    );

    target.searchParams.set("code", code.code);
    target.searchParams.set("iss", config.issuer.href.replace(/\/$/, ""));
    res.redirect(target.href);
  });

  // --- token ---------------------------------------------------------------
  router.post("/oauth/token", form, (req: Request, res: Response) => {
    void handleToken(req, res).catch(() => {
      oauthError(res, 500, "server_error", "Could not issue a token.");
    });
  });

  async function handleToken(req: Request, res: Response): Promise<void> {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const grantType = first(body.grant_type);

    if (grantType === "authorization_code") {
      const code = first(body.code);
      const verifier = first(body.code_verifier);
      const redirectUri = first(body.redirect_uri);

      const record = code === undefined ? undefined : codes.redeem(code, nowMs());
      if (!record) {
        oauthError(
          res,
          400,
          "invalid_grant",
          "The authorization code is unknown, expired, or already used.",
        );
        return;
      }
      if (record.redirect_uri !== redirectUri || record.client_id !== first(body.client_id)) {
        oauthError(
          res,
          400,
          "invalid_grant",
          "The code was issued to a different client or redirect URI.",
        );
        return;
      }
      if (verifier === undefined || !verifyCodeChallenge(verifier, record.code_challenge)) {
        oauthError(res, 400, "invalid_grant", "PKCE verification failed.");
        return;
      }
      const resource = first(body.resource);
      if (resource !== undefined && new URL(resource).href !== record.resource) {
        oauthError(
          res,
          400,
          "invalid_target",
          "resource does not match the authorization request.",
        );
        return;
      }

      await respondWithTokens(res, {
        household_id: record.household_id,
        client_id: record.client_id,
        scopes: record.scopes,
      });
      return;
    }

    if (grantType === "refresh_token") {
      const refresh = first(body.refresh_token);
      if (refresh === undefined) {
        oauthError(res, 400, "invalid_request", "refresh_token is required.");
        return;
      }
      try {
        const claims = await verifyToken(config, refresh, "refresh");
        await respondWithTokens(res, {
          household_id: claims.household_id,
          client_id: claims.client_id,
          scopes: claims.scopes,
        });
      } catch {
        oauthError(res, 400, "invalid_grant", "The refresh token is not valid.");
      }
      return;
    }

    if (grantType === "client_credentials") {
      const clientId = first(body.client_id);
      const client = clientId === undefined ? undefined : findClient(config, clientId);
      if (!client) {
        oauthError(res, 401, "invalid_client", "Unknown client_id.");
        return;
      }
      // Machine-to-machine tokens act for no household and carry no refresh token.
      const { token, expiresInSeconds } = await issueToken(
        config,
        "access",
        { household_id: "", client_id: client.client_id, scopes: ["mcp:service"] },
        nowSeconds(),
      );
      res.json({
        access_token: token,
        token_type: "Bearer",
        expires_in: expiresInSeconds,
        scope: "mcp:service",
      });
      return;
    }

    oauthError(
      res,
      400,
      "unsupported_grant_type",
      `grant_type ${String(grantType)} is not supported.`,
    );
  }

  async function respondWithTokens(
    res: Response,
    claims: { household_id: string; client_id: string; scopes: string[] },
  ): Promise<void> {
    const issuedAt = nowSeconds();
    const access = await issueToken(config, "access", claims, issuedAt);
    // Always issued: without one, a household must re-link whenever the access
    // token expires, which Amazon calls out explicitly.
    const refresh = await issueToken(config, "refresh", claims, issuedAt);

    res.json({
      access_token: access.token,
      token_type: "Bearer",
      expires_in: access.expiresInSeconds,
      refresh_token: refresh.token,
      scope: claims.scopes.join(" "),
    });
  }

  return router;
}
