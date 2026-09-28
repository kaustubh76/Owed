import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export interface AuthorizationCode {
  code: string;
  client_id: string;
  redirect_uri: string;
  household_id: string;
  scopes: string[];
  code_challenge: string;
  /** RFC 8707 — the resource the resulting token will be bound to. */
  resource: string;
  expiresAtMs: number;
}

/** Codes are short-lived and single-use; five minutes is the usual ceiling. */
export const AUTHORIZATION_CODE_TTL_MS = 5 * 60_000;

export class AuthorizationCodeStore {
  readonly #codes = new Map<string, AuthorizationCode>();

  issue(input: Omit<AuthorizationCode, "code" | "expiresAtMs">, nowMs: number): AuthorizationCode {
    const record: AuthorizationCode = {
      ...input,
      code: randomBytes(32).toString("base64url"),
      expiresAtMs: nowMs + AUTHORIZATION_CODE_TTL_MS,
    };
    this.#codes.set(record.code, record);
    return record;
  }

  /** Redeem once. A replayed code returns nothing, whether or not it had expired. */
  redeem(code: string, nowMs: number): AuthorizationCode | undefined {
    const record = this.#codes.get(code);
    if (!record) return undefined;
    this.#codes.delete(code);
    return record.expiresAtMs >= nowMs ? record : undefined;
  }
}

/**
 * PKCE `S256` verification.
 *
 * `plain` is deliberately unimplemented: OAuth 2.1 removes it, and Amazon blocks
 * deployment of an authorization server that does not advertise `S256`.
 */
export function verifyCodeChallenge(codeVerifier: string, codeChallenge: string): boolean {
  if (codeVerifier.length < 43 || codeVerifier.length > 128) return false;

  const computed = createHash("sha256").update(codeVerifier).digest();
  let expected: Buffer;
  try {
    expected = Buffer.from(codeChallenge, "base64url");
  } catch {
    return false;
  }

  return computed.length === expected.length && timingSafeEqual(computed, expected);
}
