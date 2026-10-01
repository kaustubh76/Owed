import { afterEach, describe, expect, it } from "vitest";
import { type Harness, startHarness } from "../testing/harness.js";

/**
 * `/control/*` were the only routes in the app with no auth at all, and nothing tested
 * them — not one assertion anywhere in the repo touched them before this file. They are
 * covered indirectly by `pnpm verify:ui`, through browser → brain → server, which is a
 * slow and silent place to find out that a gate is wrong.
 *
 * Both states matter. Open is what the local demo needs; gated is what a public origin
 * needs; and a change that got the first one wrong would break `pnpm demo` while the unit
 * suite stayed green.
 */
let harness: Harness;

afterEach(async () => {
  await harness.close();
});

const TOKEN = "control-token-for-tests";

/** The three routes the harness mounts. `/control/recourse` needs a `recourseLog`. */
const ROUTES = ["/control/clock", "/control/commitments"] as const;

describe("/control/* with no token configured", () => {
  it("stays open, because that is what the demo runs", async () => {
    harness = await startHarness();
    for (const route of ROUTES) {
      const response = await fetch(new URL(route, harness.baseUrl));
      expect(response.status, route).toBe(200);
    }
  });

  it("still accepts the scrubber's write", async () => {
    harness = await startHarness();
    const response = await fetch(new URL("/control/clock", harness.baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instant: "2026-10-06T18:40:00-07:00" }),
    });
    expect(response.status).toBe(200);
  });
});

describe("/control/* with a token configured", () => {
  it("refuses every route without one", async () => {
    harness = await startHarness({ controlToken: TOKEN });
    for (const route of ROUTES) {
      const response = await fetch(new URL(route, harness.baseUrl));
      expect(response.status, route).toBe(401);
    }
  });

  it("refuses the wrong token", async () => {
    harness = await startHarness({ controlToken: TOKEN });
    const response = await fetch(new URL("/control/clock", harness.baseUrl), {
      headers: { authorization: "Bearer not-the-token" },
    });
    expect(response.status).toBe(401);
  });

  it("refuses a token of the right length but the wrong bytes", async () => {
    harness = await startHarness({ controlToken: TOKEN });
    const sameLength = "x".repeat(TOKEN.length);
    const response = await fetch(new URL("/control/clock", harness.baseUrl), {
      headers: { authorization: `Bearer ${sameLength}` },
    });
    expect(response.status).toBe(401);
  });

  it("accepts the right one", async () => {
    harness = await startHarness({ controlToken: TOKEN });
    for (const route of ROUTES) {
      const response = await fetch(new URL(route, harness.baseUrl), {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(response.status, route).toBe(200);
    }
  });

  /**
   * The route that actually mutates shared state. A read leaking is bad; scenario time
   * being moved by a stranger changes what every other client is told.
   */
  it("refuses the clock write without a token, and performs it with one", async () => {
    harness = await startHarness({ controlToken: TOKEN });
    const body = JSON.stringify({ instant: "2026-10-06T18:40:00-07:00" });

    const denied = await fetch(new URL("/control/clock", harness.baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(denied.status).toBe(401);

    const allowed = await fetch(new URL("/control/clock", harness.baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body,
    });
    expect(allowed.status).toBe(200);
  });

  /** The gate must not reach `/mcp`, which has its own and a different failure shape. */
  it("leaves /mcp to its own gate", async () => {
    harness = await startHarness({ controlToken: TOKEN });
    const response = await fetch(harness.mcpUrl, { method: "POST" });
    expect(response.status).toBe(401);
    expect(response.headers.has("www-authenticate")).toBe(false);
  });
});
