/**
 * Account linking, built to Amazon's documented gates rather than to MCP defaults.
 *
 * Three of those gates are unusual and easy to get wrong:
 *  - PKCE `S256` is a hard requirement; deployment is refused without it.
 *  - Dynamic Client Registration is **not supported**, so clients are static and each
 *    registers several redirect URIs (Alexa devices link from region-specific hosts).
 *  - `WWW-Authenticate` is **not** a supported discovery mechanism, so the 401 must not
 *    carry one — see `stripWwwAuthenticate` in ./middleware.ts.
 */

export interface OAuthClient {
  client_id: string;
  /** Several, deliberately: one redirect URI fails linking for other regions. */
  redirect_uris: string[];
  scopes: string[];
  /** Public clients (PKCE, no secret) are the only kind we issue user tokens to. */
  confidential?: boolean;
  client_secret?: string;
}

export interface AuthConfig {
  /** Base URL of this authorization server. */
  issuer: URL;
  /** The protected resource these tokens are bound to (RFC 8707). */
  resource: URL;
  clients: OAuthClient[];
  scopesSupported: string[];
  accessTokenTtlSeconds: number;
  /**
   * Long-lived by design: without refresh tokens a household must re-link every time
   * the access token expires, which Amazon calls out explicitly. 180 days is the
   * documented floor.
   */
  refreshTokenTtlSeconds: number;
  secret: string;
}

export const SCOPES = {
  read: "owed.read",
  claim: "owed.claim",
} as const;

export const DEFAULT_SCOPES: string[] = [SCOPES.read, SCOPES.claim];

/** The loopback redirect an RFC 8252 native client uses; port is matched loosely. */
export const LOOPBACK_REDIRECTS = ["http://127.0.0.1/callback", "http://localhost/callback"];

export function defaultAuthConfig(baseUrl: URL, secret: string): AuthConfig {
  return {
    issuer: new URL("/", baseUrl),
    resource: new URL("/mcp", baseUrl),
    scopesSupported: DEFAULT_SCOPES,
    accessTokenTtlSeconds: 3600,
    refreshTokenTtlSeconds: 180 * 24 * 60 * 60,
    secret,
    clients: [
      {
        client_id: "owed-simulated-home",
        redirect_uris: [...LOOPBACK_REDIRECTS],
        scopes: DEFAULT_SCOPES,
      },
      {
        // Stands in for the Alexa+ client, which links from region-specific hosts.
        client_id: "alexa-plus",
        redirect_uris: [
          "https://pitangui.amazon.com/api/skill/link/owed",
          "https://layla.amazon.com/api/skill/link/owed",
          "https://alexa.amazon.co.jp/api/skill/link/owed",
          ...LOOPBACK_REDIRECTS,
        ],
        scopes: DEFAULT_SCOPES,
      },
    ],
  };
}

export function findClient(config: AuthConfig, clientId: string): OAuthClient | undefined {
  return config.clients.find((client) => client.client_id === clientId);
}

/**
 * Loopback redirects are matched ignoring the port, per RFC 8252 §7.3: a native
 * client binds an ephemeral port it cannot know in advance.
 */
export function isRedirectAllowed(client: OAuthClient, redirectUri: string): boolean {
  let candidate: URL;
  try {
    candidate = new URL(redirectUri);
  } catch {
    return false;
  }

  return client.redirect_uris.some((allowed) => {
    const registered = new URL(allowed);
    const loopback = registered.hostname === "127.0.0.1" || registered.hostname === "localhost";
    if (!loopback) return registered.href === candidate.href;
    return (
      candidate.protocol === registered.protocol &&
      candidate.hostname === registered.hostname &&
      candidate.pathname === registered.pathname
    );
  });
}
