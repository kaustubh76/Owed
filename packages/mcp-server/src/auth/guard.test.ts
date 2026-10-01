import { describe, expect, it } from "vitest";
import { assertSecretFitsBaseUrl, DEVELOPMENT_AUTH_SECRET, isLoopbackUrl } from "./guard.js";

/**
 * The guard exists because the insecure value is the convenient one: the development
 * secret keeps tokens valid across restarts, so every demo run rewards leaving it alone.
 * These tests pin the two halves of that — that it never gets in the demo's way, and that
 * it is not survivable on a public origin.
 */
const STRONG = "a".repeat(64);

describe("loopback detection", () => {
  it("recognises the forms a base URL actually takes", () => {
    for (const url of [
      "http://127.0.0.1:3939",
      "http://localhost:3939",
      "http://[::1]:3939",
      "http://owed.localhost:3939",
    ]) {
      expect(isLoopbackUrl(new URL(url)), url).toBe(true);
    }
  });

  it("does not mistake a public host for one", () => {
    for (const url of [
      "https://owed.example.com",
      "http://10.0.0.5",
      "https://127.0.0.1.evil.com",
    ]) {
      expect(isLoopbackUrl(new URL(url)), url).toBe(false);
    }
  });
});

describe("on a loopback base URL", () => {
  /** The demo's exact configuration. If this throws, `pnpm demo` is broken. */
  it("permits the development secret", () => {
    expect(() =>
      assertSecretFitsBaseUrl(DEVELOPMENT_AUTH_SECRET, new URL("http://127.0.0.1:3939")),
    ).not.toThrow();
  });

  it("permits a short secret, because nothing outside the machine can reach it", () => {
    expect(() => assertSecretFitsBaseUrl("short", new URL("http://localhost:3939"))).not.toThrow();
  });
});

describe("on a public base URL", () => {
  it("refuses the development secret", () => {
    expect(() =>
      assertSecretFitsBaseUrl(DEVELOPMENT_AUTH_SECRET, new URL("https://owed.example.com")),
    ).toThrow(/development default/);
  });

  it("names the variable and the fix, because the message is the whole mitigation", () => {
    expect(() =>
      assertSecretFitsBaseUrl(DEVELOPMENT_AUTH_SECRET, new URL("https://owed.example.com")),
    ).toThrow(/OWED_AUTH_SECRET/);
  });

  it("refuses a secret too short to survive offline attack", () => {
    expect(() =>
      assertSecretFitsBaseUrl("a".repeat(31), new URL("https://owed.example.com")),
    ).toThrow(/shorter than 32 bytes/);
  });

  it("accepts a strong one", () => {
    expect(() =>
      assertSecretFitsBaseUrl(STRONG, new URL("https://owed.example.com")),
    ).not.toThrow();
  });

  /** Byte length, not character count — a short string of wide characters is still short. */
  it("counts bytes rather than characters", () => {
    expect(() =>
      assertSecretFitsBaseUrl("é".repeat(16), new URL("https://owed.example.com")),
    ).not.toThrow();
    expect(() =>
      assertSecretFitsBaseUrl("é".repeat(15), new URL("https://owed.example.com")),
    ).toThrow();
  });
});
