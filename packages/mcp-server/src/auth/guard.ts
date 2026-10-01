/**
 * The secret that must never reach a public origin.
 *
 * Exported so `main.ts` and the guard cannot drift apart: a default defined in one place
 * and compared against a literal in another is a bug waiting for somebody to reword one of
 * them.
 */
export const DEVELOPMENT_AUTH_SECRET = "owed-development-secret-not-for-deployment";

/**
 * Shortest secret allowed on a public origin.
 *
 * HS256 is a keyed MAC over a token the attacker holds, so a weak key can be recovered
 * offline at whatever rate they care to spend. 32 bytes is the usual floor for HMAC-SHA256.
 */
export const MIN_PUBLIC_SECRET_BYTES = 32;

/**
 * Refuse to start with a guessable signing key on a public origin.
 *
 * This is a boot error rather than a warning, and that is the whole point. The insecure
 * value is the *convenient* one — it keeps tokens valid across restarts, so re-linking is
 * not part of every demo run — which means a warning would be read once and then scrolled
 * past forever.
 *
 * Why it is worth a hard failure: `householdFromAuth()` takes the household from the
 * token's `sub` rather than from configuration, which is exactly what makes the server
 * cleanly multi-tenant. With a signing key published in this repository, that same
 * property means anyone who can reach `/mcp` can mint a token for any `sub` and read or
 * write **any** household's ledger. Not a degraded guarantee — no guarantee.
 *
 * **The condition is the advertised base URL, not the bind address.** In the intended
 * deployment Caddy is co-located and the server keeps listening on `127.0.0.1`, so a
 * bind-address test would never fire in the one configuration it exists to protect.
 * `OWED_BASE_URL` is what the OAuth metadata publishes, which makes it the honest answer
 * to "can strangers reach this".
 */
export function assertSecretFitsBaseUrl(secret: string, baseUrl: URL): void {
  if (isLoopbackUrl(baseUrl)) return;

  if (secret === DEVELOPMENT_AUTH_SECRET) {
    throw new Error(
      `OWED_AUTH_SECRET is still the development default while OWED_BASE_URL is ${baseUrl.origin}.\n` +
        "That secret is published in this repository, and the household comes from the token's\n" +
        "`sub`, so anyone could mint a token for any household. Set a real secret:\n" +
        "  OWED_AUTH_SECRET=$(openssl rand -hex 32)",
    );
  }

  if (Buffer.byteLength(secret, "utf8") < MIN_PUBLIC_SECRET_BYTES) {
    throw new Error(
      `OWED_AUTH_SECRET is shorter than ${MIN_PUBLIC_SECRET_BYTES} bytes while OWED_BASE_URL is ${baseUrl.origin}.\n` +
        "HS256 signs with this key, so a short one can be recovered offline from a single token.\n" +
        "  OWED_AUTH_SECRET=$(openssl rand -hex 32)",
    );
  }
}

/**
 * Hostnames that mean "only this machine can reach it".
 *
 * `URL` normalises IPv6 hosts with brackets, so `[::1]` is what `hostname` actually
 * returns for `http://[::1]:3939` — matching on `::1` alone would silently miss it.
 */
export function isLoopbackUrl(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "[::1]" ||
    host === "::1" ||
    host.endsWith(".localhost")
  );
}
