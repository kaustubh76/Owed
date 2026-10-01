import { request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { type Harness, startHarness } from "./testing/harness.js";

/**
 * DNS-rebinding protection behind a reverse proxy.
 *
 * Caddy forwards the original `Host`, so the public hostname arrives at a validator whose
 * default allow-list is loopback only — every request 403s until it is configured. The
 * validator reads the `Host` header directly and ignores `X-Forwarded-Host`, so there is
 * no proxy setting that fixes this from the outside.
 *
 * The trap these tests exist for: `allowedHosts` **replaces** the loopback defaults rather
 * than extending them. Configuring only the public hostname would 403 `pnpm demo`, the
 * conformance probe and every other test in this repo — all of which talk to `127.0.0.1`.
 */
let harness: Harness;

afterEach(async () => {
  await harness.close();
});

const PUBLIC_HOST = "owed.example.com";

/**
 * Raw `node:http` rather than `fetch`, and that is not a style preference.
 *
 * `Host` is a forbidden header name in the Fetch spec, so `fetch` **silently discards** an
 * attempt to set it and sends the one derived from the URL. A forged-Host test written with
 * `fetch` therefore tests nothing at all, and quietly passes for the wrong reason whenever
 * the expectation happens to match loopback's behaviour. `node:http` lets the header be set,
 * which is the only way to exercise the validator this file is about.
 */
function req(
  harness: Harness,
  path: string,
  { host, method = "GET" }: { host?: string; method?: string } = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const client = request(
      {
        hostname: harness.baseUrl.hostname,
        port: harness.baseUrl.port,
        path,
        method,
        ...(host === undefined ? {} : { headers: { host } }),
      },
      (response) => {
        let body = "";
        response.on("data", (chunk) => {
          body += String(chunk);
        });
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
      },
    );
    client.on("error", reject);
    client.end();
  });
}

function get(harness: Harness, path: string, host?: string) {
  return req(harness, path, host === undefined ? {} : { host });
}

describe("with no extra hosts configured", () => {
  it("accepts loopback, which is the demo and every other test", async () => {
    harness = await startHarness();
    expect((await get(harness, "/control/clock")).status).toBe(200);
  });

  it("rejects a forged Host with 403 and a JSON-RPC body", async () => {
    harness = await startHarness();
    const response = await get(harness, "/control/clock", "attacker.example.com");
    expect(response.status).toBe(403);
    expect(JSON.parse(response.body)).toMatchObject({
      jsonrpc: "2.0",
      error: { code: -32_000 },
      id: null,
    });
  });
});

describe("with a public host configured", () => {
  it("accepts the configured host", async () => {
    harness = await startHarness({ allowedHosts: [PUBLIC_HOST] });
    expect((await get(harness, "/control/clock", PUBLIC_HOST)).status).toBe(200);
  });

  /**
   * The regression this whole file is for. Configuring a public host must not evict
   * loopback, or the local demo and the deployed server stop being the same program.
   */
  it("still accepts loopback", async () => {
    harness = await startHarness({ allowedHosts: [PUBLIC_HOST] });
    expect((await get(harness, "/control/clock")).status).toBe(200);
  });

  it("still rejects a host that was not configured", async () => {
    harness = await startHarness({ allowedHosts: [PUBLIC_HOST] });
    expect((await get(harness, "/control/clock", "attacker.example.com")).status).toBe(403);
  });

  /** Subdomains are not implied — the validator matches hostnames exactly. */
  it("does not imply subdomains", async () => {
    harness = await startHarness({ allowedHosts: [PUBLIC_HOST] });
    expect((await get(harness, "/control/clock", `evil.${PUBLIC_HOST}`)).status).toBe(403);
  });

  it("guards /mcp too, not just the control routes", async () => {
    harness = await startHarness({ allowedHosts: [PUBLIC_HOST] });
    const response = await req(harness, "/mcp", {
      method: "POST",
      host: "attacker.example.com",
    });
    expect(response.status).toBe(403);
  });
});

/**
 * An empty list is truthy, so passing it through would mount the validator with nothing
 * permitted and reject everything, loopback included. `main.ts` filters empty entries out
 * of `OWED_ALLOWED_HOSTS` for exactly this reason; this pins the behaviour at the app
 * boundary.
 */
describe("an empty configured list", () => {
  it("behaves as unconfigured rather than denying everything", async () => {
    harness = await startHarness({ allowedHosts: [] });
    expect((await get(harness, "/control/clock")).status).toBe(200);
  });
});
