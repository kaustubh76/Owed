import type { EventStore } from "@owed/core";
import { afterEach, describe, expect, it } from "vitest";
import { type Harness, startHarness } from "./testing/harness.js";

/**
 * What the server does when the ledger cannot be read.
 *
 * Nothing tested this before, and the reason is worth stating: every test in this repo used
 * `MemoryEventStore`, which **cannot fail**. So the whole class of failure that arrives with
 * DynamoDB — a throttle, a timeout, an expired instance role — had no coverage at all, and
 * one of those paths crashed the process.
 *
 * A failing store is four lines behind the existing port, which is the dividend of having a
 * port in the first place.
 */
function brokenStore(reason = "ProvisionedThroughputExceededException"): EventStore {
  return {
    append: () => Promise.reject(new Error(reason)),
    read: () => Promise.reject(new Error(reason)),
  };
}

let harness: Harness;

afterEach(async () => {
  await harness.close();
});

describe("when the ledger cannot be read", () => {
  /**
   * The crash this replaces. `/control/commitments` was a synchronous handler firing a
   * floating promise, so a rejection had nothing to catch it and became an unhandled
   * rejection — which Node answers by terminating. The brain polls this endpoint every
   * 1500 ms, so the first DynamoDB throttle would have taken the server down, and systemd's
   * start limit would then have left the unit failed.
   *
   * That the test process is still running at the end of this file is part of the assertion.
   */
  it("answers 503 on /control/commitments instead of exiting", async () => {
    harness = await startHarness();
    harness.deps.store = brokenStore();

    const response = await fetch(new URL("/control/commitments", harness.baseUrl));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "unavailable" });
  });

  it("answers 503 on /health, so a proxy can tell listening from working", async () => {
    harness = await startHarness();
    harness.deps.store = brokenStore();

    const response = await fetch(new URL("/health", harness.baseUrl));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ status: "unavailable" });
  });

  it("answers 200 on /health when the ledger is readable", async () => {
    harness = await startHarness();
    const response = await fetch(new URL("/health", harness.baseUrl));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "ok" });
  });

  /**
   * A tool call must fail as a call, not as a process. The household hearing nothing is bad;
   * the server disappearing is worse, because it takes the next household with it.
   */
  it("fails a tool call without taking the server with it", async () => {
    harness = await startHarness();
    const token = await harness.link();
    harness.deps.store = brokenStore();

    const response = await fetch(harness.mcpUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "ledger_summary", arguments: {} },
      }),
    });

    // Whatever shape it takes, the server answered rather than died.
    expect(response.status).toBeLessThan(600);

    // And it is still answering afterwards, which is the real assertion.
    harness.deps.store = brokenStore();
    const health = await fetch(new URL("/health", harness.baseUrl));
    expect(health.status).toBe(503);
  });
});
