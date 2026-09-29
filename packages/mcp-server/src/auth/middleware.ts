import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { AuthConfig } from "./config.js";
import { verifyToken } from "./tokens.js";

/** Shape the Streamable HTTP transport reads off `req.auth`. */
export interface OwedAuthInfo {
  token: string;
  clientId: string;
  scopes: string[];
  expiresAt: number;
  extra: { household_id: string };
}

/**
 * Remove the `WWW-Authenticate` challenge from every response.
 *
 * Deliberately configurable, because the guidance conflicts three ways:
 *  - Amazon's account-linking page lists `WWW-Authenticate` under *not supported*.
 *  - RFC 9728 and the wider MCP convention say a 401 SHOULD carry one, pointing at
 *    the protected-resource metadata.
 *  - `mcp-voice-simulator`'s conformance checker prefers it absent, while itself
 *    warning that the claim is secondhand and should not justify removing a header
 *    that works.
 *
 * Default is to omit it, matching the Alexa+ target. Discovery still works either
 * way, because the well-known documents are the primary path and are always served.
 * See docs/friction-log.md.
 */
export function stripWwwAuthenticate(): RequestHandler {
  return (_req: Request, res: Response, next: NextFunction) => {
    const setHeader = res.setHeader.bind(res);
    res.setHeader = ((name: string, value: number | string | readonly string[]) => {
      if (String(name).toLowerCase() === "www-authenticate") return res;
      return setHeader(name, value);
    }) as Response["setHeader"];
    next();
  };
}

function unauthorized(res: Response, description: string): void {
  // Exactly 401, with no challenge header. The conformance check is an equality test.
  res.status(401).json({ error: "invalid_token", error_description: description });
}

export interface OwedAuthOptions {
  config: AuthConfig;
  requiredScopes?: string[];
}

/**
 * Bearer gate for `/mcp`.
 *
 * Mounted ahead of the MCP handler on purpose: the conformance probe sends no
 * `Accept` header, and a server that validated `Accept` first would answer 406 where
 * the check demands 401.
 */
export function requireOwedAuth({ config, requiredScopes = [] }: OwedAuthOptions): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization;
    if (typeof header !== "string" || !header.toLowerCase().startsWith("bearer ")) {
      unauthorized(res, "A Bearer access token is required.");
      return;
    }

    const token = header.slice("bearer ".length).trim();
    void verifyToken(config, token, "access")
      .then((claims) => {
        const missing = requiredScopes.filter((scope) => !claims.scopes.includes(scope));
        if (missing.length > 0) {
          res.status(403).json({
            error: "insufficient_scope",
            error_description: `Missing scope: ${missing.join(", ")}`,
          });
          return;
        }

        const auth: OwedAuthInfo = {
          token,
          clientId: claims.client_id,
          scopes: claims.scopes,
          expiresAt: claims.expiresAtSeconds,
          extra: { household_id: claims.household_id },
        };
        (req as Request & { auth?: unknown }).auth = auth;
        next();
      })
      .catch(() =>
        unauthorized(res, "The access token is expired or not valid for this resource."),
      );
  };
}

/**
 * The household a request acts for.
 *
 * Every tool call is bound to the household in the token, never to configuration —
 * that binding is what makes the ledger multi-tenant-safe by construction.
 */
export function householdFromAuth(authInfo: unknown): string | undefined {
  const extra = (authInfo as { extra?: { household_id?: unknown } } | undefined)?.extra;
  return typeof extra?.household_id === "string" && extra.household_id.length > 0
    ? extra.household_id
    : undefined;
}
