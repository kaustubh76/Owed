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
