import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { SystemClock } from "@owed/core";
import { createMerchantAgentsApp } from "@owed/merchant-agents";
import {
  checkMerchantConformance,
  type Respondent,
  runSession,
  sampleClaim,
} from "@owed/recourse-protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { httpMerchants } from "./http.js";
import { RecourseLog } from "./log.js";

/**
 * The reference merchant agent, checked against the specification it ships with — over
 * real HTTP, through the real client, using the published conformance suite.
 */
let http: Server;
let baseUrl: URL;
let log: RecourseLog;

beforeAll(async () => {
  http = await new Promise<Server>((resolve) => {
    const server = createMerchantAgentsApp().listen(0, "127.0.0.1", () => resolve(server));
  });
  baseUrl = new URL(`http://127.0.0.1:${(http.address() as AddressInfo).port}`);
  log = new RecourseLog(new SystemClock());
});

afterAll(async () => {
  await new Promise<void>((resolve) => http.close(() => resolve()));
});

/** The directory returns undefined for merchants it cannot reach; these are reachable. */
function required(respondent: Respondent | undefined): Respondent {
  if (respondent === undefined) throw new Error("no agent for that merchant");
  return respondent;
}

const northwind = () =>
  required(
    httpMerchants({ baseUrl, log }).respondentFor("Northwind Parcel", {
      stated: { minor: 1200, currency: "USD" },
      clause_title: "Delivery Guarantee 4.2",
    }),
  );

describe("a merchant agent over HTTP", () => {
  it("satisfies the protocol's own conformance suite", async () => {
    const report = await checkMerchantConformance(northwind());

    expect(report.passed, JSON.stringify(report.results, null, 2)).toBe(true);
  });

  /**
   * The point of asking rather than telling: the claimant supplies a remedy it believes
   * in, and the merchant answers from its own published terms regardless.
   */
  it("answers from its own policy, not from what the claimant asserts", async () => {
    const overstated = required(
      httpMerchants({ baseUrl }).respondentFor("Northwind Parcel", {
        stated: { minor: 999_999, currency: "USD" },
        clause_title: "Not a real clause",
      }),
    );

    const reply = await overstated.respond([sampleClaim()]);

    // Northwind publishes twelve dollars for a phantom delivery and anchors at 0.4 of it.
    expect(reply.type).toBe("OFFER");
    expect(reply.type === "OFFER" && reply.amount).toEqual({ minor: 500, currency: "USD" });
  });

  it("negotiates a whole session across the wire", async () => {
    const claim = sampleClaim();
    const session = await runSession(
      {
        name: "test-claimant",
        open: () => claim,
        react: (transcript) =>
          transcript.some((message) => message.type === "COUNTER")
            ? { type: "ACCEPT" }
            : {
                type: "COUNTER",
                amount: { minor: 1200, currency: "USD" },
                justification: { policy_clause: "Delivery Guarantee 4.2", evidence_ids: ["evd_1"] },
              },
      },
      northwind(),
    );

    expect(session.outcome).toBe("settled");
    expect(session.settled).toEqual({ minor: 1200, currency: "USD" });
  });

  /**
   * Shutdown, from the directory's side.
   *
   * `shutdown()` in `main.ts` closed the listener and the ledger and left a live MCP
   * client per merchant behind; `close()` is the missing half. What is asserted here is
   * the part that could break something: closing must not leave the directory holding
   * dead sessions, because a shutdown can race a claim that is already in flight, and a
   * directory that answered every later claim through a closed client would fail for ever
   * — the same shape as the cached-rejection bug the brain's session had.
   *
   * It deliberately does not assert that a socket went away. Sockets here belong to the
   * runtime's global pool: `server.getConnections()` reads the same before and after a
   * close, so a test claiming otherwise would be measuring the pool, not this code.
   */
  it("closes its sessions on the way out and stays usable afterwards", async () => {
    const directory = httpMerchants({ baseUrl, log });
    const before = required(
      directory.respondentFor("Northwind Parcel", {
        stated: { minor: 1200, currency: "USD" },
        clause_title: "Delivery Guarantee 4.2",
      }),
    );
    // The same assertion as "answers from its own policy" above, not `toBeDefined()`:
    // "stays usable" is a claim about the answer, and a directory handing back a dead
    // client's empty reply would have satisfied the weaker form.
    expect(await before.respond([sampleClaim()])).toMatchObject({
      type: "OFFER",
      amount: { minor: 500, currency: "USD" },
    });

    await directory.close?.();

    const after = required(
      directory.respondentFor("Northwind Parcel", {
        stated: { minor: 1200, currency: "USD" },
        clause_title: "Delivery Guarantee 4.2",
      }),
    );
    expect(await after.respond([sampleClaim()])).toMatchObject({
      type: "OFFER",
      amount: { minor: 500, currency: "USD" },
    });
  });

  /** Teardown gets called twice, and on things that never started. Neither may throw. */
  it("can be closed twice, and closed having never connected", async () => {
    const used = httpMerchants({ baseUrl, log });
    await required(
      used.respondentFor("Northwind Parcel", {
        stated: { minor: 1200, currency: "USD" },
        clause_title: "Delivery Guarantee 4.2",
      }),
    ).respond([sampleClaim()]);

    await expect(used.close?.()).resolves.toBeUndefined();
    await expect(used.close?.()).resolves.toBeUndefined();
    await expect(httpMerchants({ baseUrl, log }).close?.()).resolves.toBeUndefined();
  });

  it("records the exchange on the wire, where the inspector can read it", async () => {
    const before = log.since(0).next;
    await northwind().respond([sampleClaim()]);
    const { frames } = log.since(before);

    expect(frames.length).toBeGreaterThan(0);
    expect(frames.some((frame) => frame.direction === "out")).toBe(true);
    expect(frames.some((frame) => frame.direction === "in")).toBe(true);
    expect(frames.every((frame) => frame.merchant === "Northwind Parcel")).toBe(true);
  });
});
