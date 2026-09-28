import type { AuthConfig } from "./config.js";

/**
 * RFC 8414 Authorization Server Metadata.
 *
 * Two fields here decide whether Alexa+ will link at all, and two of the four binding
 * conformance checks read them:
 *  - `code_challenge_methods_supported` must contain `S256`.
 *  - `grant_types_supported` must contain `authorization_code`.
 *
 * Dynamic Client Registration is deliberately absent — there is no
 * `registration_endpoint`, because Alexa+ does not support DCR and advertising one
 * would promise a capability we do not honour.
 */
export function authorizationServerMetadata(config: AuthConfig): Record<string, unknown> {
  const issuer = config.issuer.href.replace(/\/$/, "");
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token", "client_credentials"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_basic"],
    scopes_supported: config.scopesSupported,
    // RFC 8707: this server issues tokens bound to a named resource.
    authorization_response_iss_parameter_supported: true,
    service_documentation: `${issuer}/docs/account-linking`,
  };
}

/** RFC 9728 Protected Resource Metadata. */
export function protectedResourceMetadata(config: AuthConfig): Record<string, unknown> {
  return {
    resource: config.resource.href,
    // Both discovery-based conformance checks fail outright without this array.
    authorization_servers: [config.issuer.href.replace(/\/$/, "")],
    scopes_supported: config.scopesSupported,
    bearer_methods_supported: ["header"],
    resource_name: "Owed",
  };
}
