import type { AuthConfig } from "./config.js";

/**
 * The page `service_documentation` points at, which until now was a 404.
 *
 * RFC 8414 describes the field as "a page containing human-readable information that
 * developers might want or need to use the service", and `metadata.ts` has advertised
 * `${issuer}/docs/account-linking` since it was written while nothing served that path. An
 * integrator reading the discovery document — which, for an Alexa+ add-on, is the first
 * thing anyone does — followed it and got nothing.
 *
 * Its own module rather than sixty lines inside `router.ts`, for a reason beyond tidiness:
 * `docs/friction-log.md` §3 uses the size of the authorization server as evidence that the
 * SDK ships none, and a documentation page is not work the SDK forced on anyone. Keeping it
 * out of `router.ts` keeps that argument measuring what it claims to measure.
 *
 * Everything here is derived from `config` rather than written out again, so it cannot
 * drift from what the server actually does.
 */
export function accountLinkingPage(config: AuthConfig): string {
  const issuer = config.issuer.href.replace(/\/$/, "");
  const clients = config.clients
    .map(
      (client) =>
        `<li><code>${client.client_id}</code> — ${client.redirect_uris.length} redirect URIs, scopes <code>${client.scopes.join(" ")}</code></li>`,
    )
    .join("");
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<title>Linking an account to Owed</title>` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<style>body{font:16px/1.6 system-ui,sans-serif;max-width:46rem;margin:3rem auto;padding:0 1rem}` +
    `code{background:#f4f4f5;padding:.1em .3em;border-radius:3px}h1{font-size:1.4rem}` +
    `h2{font-size:1.05rem;margin-top:2rem}</style></head><body>` +
    `<h1>Linking an account to Owed</h1>` +
    `<p>Owed is its own OAuth 2.1 authorization server. Authorization code with PKCE is the ` +
    `only flow it issues household tokens for.</p>` +
    `<h2>Endpoints</h2><ul>` +
    `<li>Authorization: <code>${issuer}/oauth/authorize</code></li>` +
    `<li>Token: <code>${issuer}/oauth/token</code></li>` +
    `<li>Metadata: <code>${issuer}/.well-known/oauth-authorization-server</code> and ` +
    `<code>${issuer}/.well-known/oauth-protected-resource</code>, each also served with a ` +
    `<code>/mcp</code> suffix</li>` +
    `<li>Protected resource: <code>${config.resource.href}</code></li></ul>` +
    `<h2>What is required</h2><ul>` +
    `<li><code>code_challenge_method=S256</code>. Anything else is refused; <code>plain</code> ` +
    `is not accepted.</li>` +
    `<li><code>resource</code> on both the authorization and token requests (RFC 8707). ` +
    `Tokens are bound to one protected resource and rejected for any other.</li>` +
    `<li>An authorization code is single-use and expires in five minutes.</li>` +
    `<li>Access tokens last ${config.accessTokenTtlSeconds} seconds; refresh tokens ` +
    `${config.refreshTokenTtlSeconds} seconds.</li></ul>` +
    `<h2>What is not supported</h2><ul>` +
    `<li><strong>Dynamic client registration.</strong> There is no ` +
    `<code>registration_endpoint</code>. Clients are static, below.</li>` +
    `<li><strong>Any grant but authorization code and refresh.</strong> Alexa+ add-ons ` +
    `support only the authorization code grant; a client credentials grant was removed ` +
    `because it issued a token that acted for no household.</li>` +
    `<li><strong><code>WWW-Authenticate</code> on a 401.</strong> Omitted for the Alexa+ ` +
    `target; discovery is through the documents above.</li></ul>` +
    `<h2>Registered clients</h2><ul>${clients}</ul>` +
    `<p>Loopback redirect URIs are matched ignoring the port, per RFC 8252 §7.3, because a ` +
    `native client binds a port it cannot know in advance.</p>` +
    `</body></html>`
  );
}
