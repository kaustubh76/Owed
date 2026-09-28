import { jwtVerify, SignJWT } from "jose";
import type { AuthConfig } from "./config.js";

export interface TokenClaims {
  /** The household this token acts for. Every tool call is bound to it. */
  household_id: string;
  client_id: string;
  scopes: string[];
  expiresAtSeconds: number;
}

export type TokenKind = "access" | "refresh";

interface OwedJwtPayload {
  sub?: string;
  aud?: string | string[];
  iss?: string;
  exp?: number;
  scope?: string;
  client_id?: string;
  kind?: string;
}

function key(config: AuthConfig): Uint8Array {
  return new TextEncoder().encode(config.secret);
}

/**
 * Tokens are symmetric (HS256) because this authorization server and the resource
 * server are the same process. A deployment that separated them would move to
 * asymmetric keys and publish a JWKS; the claim set below would not change.
 */
export async function issueToken(
  config: AuthConfig,
  kind: TokenKind,
  claims: Omit<TokenClaims, "expiresAtSeconds">,
  nowSeconds: number,
): Promise<{ token: string; expiresInSeconds: number }> {
  const ttl = kind === "access" ? config.accessTokenTtlSeconds : config.refreshTokenTtlSeconds;

  const token = await new SignJWT({
    scope: claims.scopes.join(" "),
    client_id: claims.client_id,
    kind,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(config.issuer.href)
    // RFC 8707: the token is bound to one protected resource and no other.
    .setAudience(config.resource.href)
    .setSubject(claims.household_id)
    .setIssuedAt(nowSeconds)
    .setExpirationTime(nowSeconds + ttl)
    .sign(key(config));

  return { token, expiresInSeconds: ttl };
}

export class InvalidTokenError extends Error {}

export async function verifyToken(
  config: AuthConfig,
  token: string,
  expected: TokenKind,
): Promise<TokenClaims> {
  let payload: OwedJwtPayload;
  try {
    const verified = await jwtVerify(token, key(config), {
      issuer: config.issuer.href,
      audience: config.resource.href,
      // Pinning the algorithm closes the "alg: none" and confusion attacks.
      algorithms: ["HS256"],
    });
    payload = verified.payload as OwedJwtPayload;
  } catch (cause) {
    throw new InvalidTokenError("token is not valid for this resource", { cause });
  }

  if (payload.kind !== expected) {
    throw new InvalidTokenError(`expected a ${expected} token`);
  }
  if (typeof payload.sub !== "string" || typeof payload.exp !== "number") {
    throw new InvalidTokenError("token is missing required claims");
  }

  return {
    household_id: payload.sub,
    client_id: payload.client_id ?? "",
    scopes: payload.scope ? payload.scope.split(" ") : [],
    expiresAtSeconds: payload.exp,
  };
}
