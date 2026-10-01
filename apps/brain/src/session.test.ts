import type { Client } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import { type Established, openSession, RENEW_AT, type SessionStatus } from "./session.js";

/**
 * The brain's session lifecycle, which is where the two worst bugs in this project lived:
 * a one-hour token held forever, and a dead transport nobody was listening for. Both
 * produced the same thing — a demo reading "brain connected" that answered nothing —
 * and neither had a test, because testing them appeared to need a server and a clock.
 *
 * It needs neither. `connect` is injectable, so these drive the real lifecycle code with a
 * fake establishment step: fast, deterministic, and no credentials.
 */

/** Minimal stand-in. The manager only ever assigns `onclose`/`onerror` and calls `close`. */
function fakeClient(): Client & { closed: boolean } {
  const client = {
    closed: false,
    close() {
      client.closed = true;
      return Promise.resolve();
    },
  };
  return client as unknown as Client & { closed: boolean };
}

interface Harness {
  statuses: SessionStatus[];
  connects: number;
  clients: Array<Client & { closed: boolean }>;
}

function harness(plan: { expiresInSeconds?: number; failTimes?: number }): {
  h: Harness;
  connect: () => Promise<Established>;
} {
  const h: Harness = { statuses: [], connects: 0, clients: [] };
  let remainingFailures = plan.failTimes ?? 0;

  const connect = async (): Promise<Established> => {
    h.connects += 1;
    if (remainingFailures > 0) {
      remainingFailures -= 1;
      throw new Error("link refused");
    }
    const client = fakeClient();
    h.clients.push(client);
    return {
      client,
      ...(plan.expiresInSeconds === undefined ? {} : { expiresInSeconds: plan.expiresInSeconds }),
    };
  };

  return { h, connect };
}

function open(
  connect: () => Promise<Established>,
  h: Harness,
  extra: { expiresInSeconds?: number } = {},
) {
  void extra;
  return openSession({
    url: new URL("http://127.0.0.1:3939/mcp"),
    baseUrl: new URL("http://127.0.0.1:3939"),
    clientId: "test",
    onFrame: () => {},
    onStatus: (status) => h.statuses.push(status),
    connect,
  });
}

describe("establishing a session", () => {
  it("links once and reuses it", async () => {
    const { h, connect } = harness({});
    const session = open(connect, h);

    await session.call(() => Promise.resolve("a"));
    await session.call(() => Promise.resolve("b"));

    expect(h.connects).toBe(1);
    expect(h.statuses).toEqual(["linking", "live"]);
    session.stop();
  });

  it("reports linking then live", async () => {
    const { h, connect } = harness({});
    const session = open(connect, h);
    await session.ready();
    expect(h.statuses).toEqual(["linking", "live"]);
    session.stop();
  });

  /**
   * The outage case. N queued calls must not become N link attempts, or a brief server
   * restart turns the brain into a thundering herd against the thing that is already
   * struggling.
   */
  it("shares one in-flight attempt across concurrent calls", async () => {
    const { h, connect } = harness({});
    const session = open(connect, h);

    await Promise.all([
      session.call(() => Promise.resolve(1)),
      session.call(() => Promise.resolve(2)),
      session.call(() => Promise.resolve(3)),
    ]);

    expect(h.connects).toBe(1);
    session.stop();
  });
});

describe("recovering", () => {
  /** The server-restart case: the call fails, the session is rebuilt, the answer arrives. */
  it("rebuilds and retries once when a call fails", async () => {
    const { h, connect } = harness({});
    const session = open(connect, h);
    await session.ready();

    let attempts = 0;
    const result = await session.call(() => {
      attempts += 1;
      if (attempts === 1) return Promise.reject(new Error("transport closed"));
      return Promise.resolve("recovered");
    });

    expect(result).toBe("recovered");
    expect(attempts).toBe(2);
    expect(h.connects).toBe(2);
    expect(h.statuses).toEqual(["linking", "live", "lost", "linking", "live"]);
    session.stop();
  });

  /** A real failure must still surface — retrying forever would hide a broken server. */
  it("gives up after one retry", async () => {
    const { h, connect } = harness({});
    const session = open(connect, h);
    await session.ready();

    await expect(session.call(() => Promise.reject(new Error("still broken")))).rejects.toThrow(
      /still broken/,
    );
    session.stop();
  });

  it("rebuilds after an explicit invalidate", async () => {
    const { h, connect } = harness({});
    const session = open(connect, h);
    await session.ready();

    session.invalidate("test");
    await session.call(() => Promise.resolve("ok"));

    expect(h.connects).toBe(2);
    session.stop();
  });

  /**
   * `onclose` is the hook the old code never assigned, which is the entire reason a dead
   * session looked healthy. Asserted by reaching for the client the manager handed out and
   * firing it, exactly as the transport would.
   */
  it("notices a transport closing underneath it", async () => {
    const { h, connect } = harness({});
    const session = open(connect, h);
    await session.ready();

    h.clients[0]?.onclose?.();
    expect(h.statuses).toEqual(["linking", "live", "lost"]);

    await session.call(() => Promise.resolve("ok"));
    expect(h.connects).toBe(2);
    session.stop();
  });

  it("notices a transport error", async () => {
    const { h, connect } = harness({});
    const session = open(connect, h);
    await session.ready();

    h.clients[0]?.onerror?.(new Error("ECONNRESET"));
    expect(h.statuses.at(-1)).toBe("lost");
    session.stop();
  });

  /**
   * A failed attempt must not be cached. Re-awaiting a rejected promise is how one bad
   * moment becomes permanent — the bug the merchant client cache still has.
   */
  it("does not cache a failed attempt", async () => {
    const { h, connect } = harness({ failTimes: 1 });
    const session = open(connect, h);

    await expect(session.ready()).rejects.toThrow(/link refused/);
    await session.ready();

    expect(h.connects).toBe(2);
    session.stop();
  });
});

describe("token expiry", () => {
  /**
   * The headline bug: `accessTokenTtlSeconds` is 3600 and the token was frozen into the
   * transport at construction, so the brain stopped working one hour after boot — no
   * crash, no log, header still green.
   *
   * A one-second lifetime renews at 0.8s, so this is a real timer rather than a mocked one.
   */
  it("drops the session before the token expires", async () => {
    const { h, connect } = harness({ expiresInSeconds: 1 });
    const session = open(connect, h);
    await session.ready();

    expect(h.statuses).toEqual(["linking", "live"]);
    await new Promise((resolve) => setTimeout(resolve, RENEW_AT * 1000 + 250));

    expect(h.statuses).toEqual(["linking", "live", "lost"]);

    // And the next call transparently re-links, so the household never sees it.
    await session.call(() => Promise.resolve("ok"));
    expect(h.connects).toBe(2);
    session.stop();
  });

  /** A statically supplied token has nothing to renew with, so no timer is armed. */
  it("arms no timer when there is no expiry", async () => {
    const { h, connect } = harness({});
    const session = open(connect, h);
    await session.ready();

    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(h.statuses).toEqual(["linking", "live"]);
    session.stop();
  });
});

describe("stopping", () => {
  it("closes the client and refuses further calls", async () => {
    const { h, connect } = harness({});
    const session = open(connect, h);
    await session.ready();

    session.stop();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(h.clients[0]?.closed).toBe(true);
    await expect(session.call(() => Promise.resolve("x"))).rejects.toThrow(/stopped/);
  });
});
