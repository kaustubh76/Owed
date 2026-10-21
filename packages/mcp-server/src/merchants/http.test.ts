import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { SystemClock } from "@owed/core";
import { createMerchantAgentsApp, STORYBOARD_MERCHANTS } from "@owed/merchant-agents";
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

/**
 * Every shipped agent, against the suite the protocol publishes, over real HTTP.
 *
 * `@owed/recourse-protocol` is offered for lifting in `readme.md` §15, and part of what makes
 * it worth lifting is that it ships `checkMerchantConformance` — "here is the protocol, and
 * here is how to check your agent speaks it". Four reference agents ship with it and only
 * Northwind Parcel was run through it.
 *
 * Two breach kinds, because the agents differ on purpose and the replies they give decide
 * which checks have anything to judge. `phantom_delivery` is covered by Northwind's published
 * policy, so it negotiates; the rest have no published remedy for the sample claim and
 * DECLINE, which is the protocol-correct answer and the only way
 * `decline-carries-escalation-route` is exercised at all.
 *
 * That matters more than it looks. The single conformance test this file used to hold ran
 * Northwind on `phantom_delivery` — which is the one combination of the eight below where
 * that check does **not** fire. So the assertion that a refusal leaves the household
 * somewhere to go, which `product_ideation.md` §10 lists as a required property, was passing
 * vacuously in the only place it ran.
 */
const BREACH_KINDS = ["phantom_delivery", "late_refund"] as const;

const agentFor = (merchant: string) =>
  required(
    httpMerchants({ baseUrl, log }).respondentFor(merchant, {
      stated: { minor: 1200, currency: "USD" },
      clause_title: "Delivery Guarantee 4.2",
    }),
  );

describe("every shipped agent, against the published conformance suite", () => {
  for (const config of STORYBOARD_MERCHANTS) {
    for (const kind of BREACH_KINDS) {
      it(`${config.merchant} conforms on ${kind}`, async () => {
        const report = await checkMerchantConformance(
          agentFor(config.merchant),
          sampleClaim({ breach_kind: kind }),
        );

        expect(report.passed, JSON.stringify(report.results, null, 2)).toBe(true);
      });
    }
  }

  /**
   * And the suite is not passing by never asking.
   *
   * A conformance run whose interesting checks had nothing to judge reports coverage it does
   * not have, which is how the escalation assertion went unexercised in the single test this
   * file used to hold. Every non-advisory check a passing run records has to be applicable for
   * at least one agent and breach kind — countable because `MerchantCheck` reports it, rather
   * than matched against the `detail` prose.
   *
   * Measured across the eight runs, which is worth writing down because one of them is close
   * to the line:
   *
   *   valid-messages                     applicable 8 of 8
   *   no-claimant-messages               applicable 8 of 8
   *   echoes-claim-id                    applicable 8 of 8
   *   reaches-a-conclusion               applicable 8 of 8
   *   decline-carries-escalation-route   applicable 7 of 8
   *   matching-currency                  applicable 1 of 8   <- only Northwind on phantom_delivery
   *
   * `matching-currency` needs a reply that names an amount, and seven of the eight runs
   * DECLINE, which carries none. One is not zero, so it fires — but it is the check to watch
   * if the agents' policies ever change.
   *
   * `replies-to-claim` is deliberately absent: `checkMerchantConformance` records it only in
   * the `catch` around the first `respond`, to report an agent that throws, and returns early.
   * A conformant agent never produces it, so it is a failure-only record rather than a check
   * that passed without asking.
   */
  it("exercises every check a passing run records", async () => {
    const applicable = new Map<string, boolean>();

    for (const config of STORYBOARD_MERCHANTS) {
      for (const kind of BREACH_KINDS) {
        const report = await checkMerchantConformance(
          agentFor(config.merchant),
          sampleClaim({ breach_kind: kind }),
        );
        for (const check of report.results) {
          if (check.advisory === true) continue;
          applicable.set(
            check.id,
            (applicable.get(check.id) ?? false) || check.applicable !== false,
          );
        }
      }
    }

    const never = [...applicable].filter(([, ever]) => !ever).map(([id]) => id);
    expect(never, `these checks never had anything to judge: ${never.join(", ")}`).toStrictEqual(
      [],
    );

    // The exact set, so a check cannot be added to the suite without being exercised here.
    expect([...applicable.keys()].toSorted()).toStrictEqual([
      "decline-carries-escalation-route",
      "echoes-claim-id",
      "matching-currency",
      "no-claimant-messages",
      "reaches-a-conclusion",
      "valid-messages",
    ]);
  });

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

/**
 * A merchant that accepts the connection and never answers.
 *
 * `respond` has had an explicit ceiling since it was written; the `connect` before it had
 * none, so `initialize` fell back to the client SDK's 60s default. A merchant in this
 * state — listening, accepting, silent — held `claim_file` open for a minute before a
 * single round of negotiation had happened, and outlasted the brain's own untimed call,
 * which gave up first and retried the whole tool call underneath it.
 *
 * The timeout is injected rather than waited out: proving a 5s ceiling by sleeping 5s in
 * the suite would be the slowest test in the repository, and proving it by reading the
 * constant would prove nothing about `connect` being given it.
 */
describe("a merchant that accepts the connection and goes quiet", () => {
  let silent: Server;
  let silentUrl: URL;

  beforeAll(async () => {
    silent = await new Promise<Server>((resolve) => {
      // Never writes a response, never closes. The socket stays open and the request hangs.
      const server = createServer(() => {});
      server.listen(0, "127.0.0.1", () => resolve(server));
    });
    const { port } = silent.address() as AddressInfo;
    silentUrl = new URL(`http://127.0.0.1:${port}`);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => silent.close(() => resolve()));
  });

  it("gives up on the handshake instead of holding the claim", async () => {
    const directory = httpMerchants({
      baseUrl: silentUrl,
      timeouts: { connectMs: 250 },
    });
    const respondent = required(
      directory.respondentFor("Northwind Parcel", {
        stated: { minor: 1200, currency: "USD" },
        clause_title: "Delivery Guarantee 4.2",
      }),
    );

    const started = Date.now();
    await expect(respondent.respond([sampleClaim()])).rejects.toThrow();
    const waited = Date.now() - started;

    // Comfortably inside the SDK's 60s default, which is the behaviour being replaced.
    expect(waited, `waited ${waited}ms`).toBeLessThan(5_000);
    await directory.close?.();
  });
});
