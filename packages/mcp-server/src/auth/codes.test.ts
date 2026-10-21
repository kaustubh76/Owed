import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AUTHORIZATION_CODE_TTL_MS, AuthorizationCodeStore, verifyCodeChallenge } from "./codes.js";

/**
 * The three guarantees the authorization server rests on, none of which had a test.
 *
 * `codes.ts` had no test file at all, and `verifyCodeChallenge`, `redeem` and
 * `AUTHORIZATION_CODE_TTL_MS` were referenced only by their own definitions and their single
 * caller in `router.ts`. `auth.test.ts` is thorough about the *shape* of the server — S256
 * advertised, metadata at both RFC 9728 locations, unknown clients and unregistered redirect
 * URIs refused, a full authorization-code flow, household scoping — and tested none of what
 * PKCE is actually for.
 *
 * The implementation was correct when I came to write these; nothing here is a bug fix. But
 * `readme.md` §13 leads with "its own OAuth 2.1 authorization server — PKCE S256, RFC 9728,
 * 8414, 8707, 8252", and a security property with no test is a property nobody is holding.
 */

/** A verifier of the shortest length RFC 7636 permits, and its S256 challenge. */
function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return {
    verifier,
    challenge: createHash("sha256").update(verifier).digest("base64url"),
  };
}

describe("PKCE S256 verification", () => {
  it("accepts the verifier the challenge was made from", () => {
    const { verifier, challenge } = pkcePair();
    expect(verifyCodeChallenge(verifier, challenge)).toBe(true);
  });

  /**
   * The whole point of PKCE: a stolen authorization code is useless without the verifier,
   * which never leaves the client.
   */
  it("refuses any other verifier", () => {
    const { challenge } = pkcePair();
    const other = pkcePair().verifier;
    expect(verifyCodeChallenge(other, challenge)).toBe(false);
  });

  it("refuses a verifier that is one character off", () => {
    const { verifier, challenge } = pkcePair();
    const nudged = `${verifier.slice(0, -1)}${verifier.endsWith("A") ? "B" : "A"}`;
    expect(nudged).not.toBe(verifier);
    expect(verifyCodeChallenge(nudged, challenge)).toBe(false);
  });

  /** RFC 7636 §4.1: 43 to 128 characters. Both ends, because a bound is two decisions. */
  it("enforces the length bounds at both ends", () => {
    const { challenge } = pkcePair();
    expect(verifyCodeChallenge("a".repeat(42), challenge), "42 is too short").toBe(false);
    expect(verifyCodeChallenge("a".repeat(129), challenge), "129 is too long").toBe(false);

    // And the boundary values are themselves admissible — a bound that rejects its own
    // endpoints would pass the two assertions above while being wrong.
    for (const length of [43, 128]) {
      const verifier = "a".repeat(length);
      const matching = createHash("sha256").update(verifier).digest("base64url");
      expect(verifyCodeChallenge(verifier, matching), `${length} should be allowed`).toBe(true);
    }
  });

  /**
   * A malformed challenge must be refused rather than crash the token endpoint.
   *
   * `timingSafeEqual` throws a `RangeError` when the two buffers differ in length, so the
   * `computed.length === expected.length` guard in front of it is load-bearing: without it a
   * `code_challenge` of the wrong size would take the process down from an unauthenticated
   * endpoint. It was already there; now it is held.
   */
  it("refuses a malformed or wrong-length challenge without throwing", () => {
    const { verifier } = pkcePair();
    for (const challenge of ["", "short", "not base64url!!", "a".repeat(10), "a".repeat(200)]) {
      expect(() => verifyCodeChallenge(verifier, challenge)).not.toThrow();
      expect(verifyCodeChallenge(verifier, challenge), JSON.stringify(challenge)).toBe(false);
    }
  });
});

describe("authorization codes", () => {
  const issued = (store: AuthorizationCodeStore, nowMs: number) =>
    store.issue(
      {
        client_id: "owed-simulated-home",
        redirect_uri: "http://127.0.0.1:0/callback",
        household_id: "hh_demo",
        scopes: ["owed.read"],
        code_challenge: pkcePair().challenge,
        resource: "http://127.0.0.1:3939/mcp",
      },
      nowMs,
    );

  it("redeems once", () => {
    const store = new AuthorizationCodeStore();
    const code = issued(store, 0);

    expect(store.redeem(code.code, 0)?.household_id).toBe("hh_demo");
  });

  /** OAuth 2.1 requires single use. A replayed code is the attack this prevents. */
  it("returns nothing for a replayed code", () => {
    const store = new AuthorizationCodeStore();
    const code = issued(store, 0);

    expect(store.redeem(code.code, 0)).toBeDefined();
    expect(store.redeem(code.code, 0), "a code is spent on first use").toBeUndefined();
  });

  it("returns nothing for a code it never issued", () => {
    expect(new AuthorizationCodeStore().redeem("not-a-code", 0)).toBeUndefined();
  });

  it("returns nothing once the code has expired", () => {
    const store = new AuthorizationCodeStore();
    const code = issued(store, 0);

    expect(store.redeem(code.code, AUTHORIZATION_CODE_TTL_MS + 1)).toBeUndefined();
  });

  it("still honours a code at the last instant of its life", () => {
    const store = new AuthorizationCodeStore();
    const code = issued(store, 0);

    expect(store.redeem(code.code, AUTHORIZATION_CODE_TTL_MS)).toBeDefined();
  });

  /**
   * An expired code is spent as well as refused.
   *
   * `redeem` deletes before it checks the clock — deliberately, per its comment: "a replayed
   * code returns nothing, whether or not it had expired". Were it the other way round, an
   * expired code could be retried indefinitely.
   */
  it("spends an expired code rather than leaving it to be retried", () => {
    const store = new AuthorizationCodeStore();
    const code = issued(store, 0);

    expect(store.redeem(code.code, AUTHORIZATION_CODE_TTL_MS + 1)).toBeUndefined();
    expect(store.redeem(code.code, 0), "and it is gone, not merely stale").toBeUndefined();
  });

  it("issues codes that differ", () => {
    const store = new AuthorizationCodeStore();
    const codes = new Set([issued(store, 0).code, issued(store, 0).code, issued(store, 0).code]);
    expect(codes.size).toBe(3);
  });
});
