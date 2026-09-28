import { createHash, randomBytes } from "node:crypto";

export interface LinkResult {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
  scope: string;
}

export interface LinkOptions {
  baseUrl: URL;
  clientId: string;
  /** Loopback redirect, RFC 8252. Never actually dereferenced — only parsed. */
  redirectUri?: string;
  scope?: string;
}

function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(64).toString("base64url");
  return {
    verifier,
    challenge: createHash("sha256").update(verifier).digest("base64url"),
  };
}

/**
 * Complete the authorization-code + PKCE flow without a browser.
 *
 * This walks exactly the endpoints a real client walks — discovery, consent, token —
 * rather than minting a token behind the server's back, so the tests and the demo
 * exercise the same code path Alexa+ would.
 */
export async function linkAccount(options: LinkOptions): Promise<LinkResult> {
  const redirectUri = options.redirectUri ?? "http://127.0.0.1:8765/callback";
  const { verifier, challenge } = pkcePair();
  const state = randomBytes(16).toString("base64url");

  const discovery = await fetch(new URL("/.well-known/oauth-protected-resource", options.baseUrl));
  if (!discovery.ok) throw new Error("protected resource metadata is not available");
  const { resource } = (await discovery.json()) as { resource: string };

  const params = new URLSearchParams({
    response_type: "code",
    client_id: options.clientId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    resource,
    ...(options.scope === undefined ? {} : { scope: options.scope }),
  });

  // A real client renders this page for the person; here the consent is posted directly.
  const consent = await fetch(new URL("/oauth/authorize", options.baseUrl), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...Object.fromEntries(params), decision: "allow" }),
    redirect: "manual",
  });

  const location = consent.headers.get("location");
  if (location === null) {
    throw new Error(`authorization did not redirect (status ${consent.status})`);
  }

  const redirected = new URL(location);
  const error = redirected.searchParams.get("error");
  if (error !== null) {
    throw new Error(
      `authorization failed: ${error} ${redirected.searchParams.get("error_description") ?? ""}`,
    );
  }
  if (redirected.searchParams.get("state") !== state) {
    throw new Error("state did not round-trip; refusing the response");
  }

  const code = redirected.searchParams.get("code");
  if (code === null) throw new Error("authorization returned no code");

  const tokenResponse = await fetch(new URL("/oauth/token", options.baseUrl), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: options.clientId,
      redirect_uri: redirectUri,
      resource,
    }),
  });

  if (!tokenResponse.ok) {
    throw new Error(`token request failed: ${tokenResponse.status} ${await tokenResponse.text()}`);
  }

  const payload = (await tokenResponse.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    scope: string;
  };

  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    expiresInSeconds: payload.expires_in,
    scope: payload.scope,
  };
}
