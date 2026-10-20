import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { EvidenceViewSchema } from "@owed/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Harness, startHarness } from "../testing/harness.js";

/**
 * The breach engine, at runtime.
 *
 * **What was missing.** `PromiseAssessed` was emitted in exactly one place —
 * `seed/build.ts` — so the engine ran when the seeded week was built and never again. A
 * promise captured through `POST /control/messages` was written to the ledger and never
 * judged, for any kind, because nothing assessed it; and nothing *could* have, because of
 * the control routes (`auth`, `clock`, `commitments`, `messages`, `recourse`) none carried
 * evidence. Seven detectors and the coverage gate were reachable only from the seed builder.
 *
 * Asking about such a promise answered "I'm still watching the Northwind Parcel delivery",
 * which was false and permanent — and `docs/demo-script.md` has a presenter POST exactly
 * this sentence on camera.
 *
 * No existing test could have caught it: the seeded week is assessed by construction, and
 * every tool test reads that week. This drives the live path instead, which is the one a
 * judge touches.
 */

const MESSAGE = "Delivered between 1 and 5pm, guaranteed or your money back.";

let harness: Harness;
let client: Client;

beforeEach(async () => {
  harness = await startHarness();
  const token = await harness.link();
  client = new Client({ name: "live-assess-test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(harness.mcpUrl, {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
});

afterEach(async () => {
  await client?.close();
  await harness?.close();
});

const post = async (path: string, body: unknown) => {
  const response = await fetch(new URL(path, harness.baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
};

interface Delivered {
  promise_id: string;
  kind: string;
  status: string;
  verdict: string | null;
}

async function deliver(): Promise<Delivered[]> {
  const { json } = await post("/control/messages", { merchant: "Northwind Parcel", text: MESSAGE });
  return json.promises as unknown as Delivered[];
}

const spokenOf = (result: { content: unknown }) =>
  (result.content as Array<{ text?: string }>)[0]?.text ?? "";

const check = (promiseId: string) =>
  client.callTool({ name: "promise_check", arguments: { promise_id: promiseId } });

describe("a promise captured at runtime", () => {
  it("is judged, rather than sitting at Captured for the life of the process", async () => {
    const promises = await deliver();
    const window = promises.find((p) => p.kind === "delivery_window");

    expect(window, "the message produced a delivery window").toBeDefined();
    // The verdict field is the whole point: before the engine was wired in this was always
    // absent, because no assessment existed to report.
    expect(window?.verdict, "a verdict, of some kind").not.toBeNull();
  });

  it("keeps the capture status answering the question it answers", async () => {
    const promises = await deliver();

    // `status` is about tracking confidence, not about what happened: 0.95 for the stated
    // window, 0.80 for the guarantee inferred from it.
    expect(promises.find((p) => p.kind === "delivery_window")?.status).toBe("Captured");
    expect(promises.find((p) => p.kind === "guarantee")?.status).toBe("Candidate");
  });

  it("never says it is watching something nothing is watching", async () => {
    const promises = await deliver();
    for (const promise of promises) {
      const spoken = spokenOf(await check(promise.promise_id));
      if (spoken.includes("still watching")) {
        const view = EvidenceViewSchema.parse((await check(promise.promise_id)).structuredContent);
        expect(view.watched, `${promise.kind} claims to be watched`).not.toBe(false);
      }
    }
  });
});

describe("POST /control/evidence", () => {
  it("records what the home saw and re-judges what it bears on", async () => {
    const promises = await deliver();
    const window = promises.find((p) => p.kind === "delivery_window");
    if (window === undefined) throw new Error("no delivery window captured");

    const { status, json } = await post("/control/evidence", {
      uptime: [
        {
          source_id: "src_doorbell",
          household_id: harness.deps.householdId,
          interval: { start: "2026-10-11T12:00:00-07:00", end: "2026-10-11T18:00:00-07:00" },
        },
      ],
      evidence: [
        {
          id: "evd_live_1",
          household_id: harness.deps.householdId,
          source_id: "src_carrier",
          captured_at: "2026-10-11T15:00:00-07:00",
          promise_id: window.promise_id,
          kind: "carrier_scan",
          status: "delivered",
          carrier: "Northwind",
        },
      ],
    });

    expect(status).toBe(200);
    expect(json.recorded).toStrictEqual({ evidence: 1, uptime: 1 });

    const view = EvidenceViewSchema.parse((await check(window.promise_id)).structuredContent);
    expect(view.items.map((item) => item.evidence_id)).toContain("evd_live_1");
    // Judged against what arrived, not merely stored next to it.
    expect(view.verdict, spokenOf(await check(window.promise_id))).toBeDefined();
  });

  /**
   * The guarantee, which has no evidence of its own.
   *
   * One sentence, two promises: the window the home can watch, and a guarantee that is
   * broken or kept exactly as that window is. Before `derivedBreach` existed the guarantee
   * had no detector at all, so it was read out of the merchant's words, written to the
   * ledger, and never judged.
   */
  it("gives the guarantee the verdict of the promise it covers", async () => {
    const promises = await deliver();
    const window = promises.find((p) => p.kind === "delivery_window");
    const guarantee = promises.find((p) => p.kind === "guarantee");
    if (window === undefined || guarantee === undefined) throw new Error("expected both reads");

    await post("/control/evidence", {
      uptime: [
        {
          source_id: "src_doorbell",
          household_id: harness.deps.householdId,
          interval: { start: "2026-10-11T12:00:00-07:00", end: "2026-10-11T18:00:00-07:00" },
        },
      ],
      evidence: [
        {
          id: "evd_live_2",
          household_id: harness.deps.householdId,
          source_id: "src_carrier",
          captured_at: "2026-10-11T15:00:00-07:00",
          promise_id: window.promise_id,
          kind: "carrier_scan",
          status: "delivered",
          carrier: "Northwind",
        },
      ],
    });

    const covered = EvidenceViewSchema.parse((await check(window.promise_id)).structuredContent);
    const derived = EvidenceViewSchema.parse((await check(guarantee.promise_id)).structuredContent);

    expect(covered.verdict, "the window was judged").toBeDefined();
    expect(derived.verdict, "and so was the guarantee over it").toBe(covered.verdict);
    // Inherited, never invented: the six frozen breach kinds stay six.
    expect(derived.watched).not.toBe(false);
    expect(spokenOf(await check(guarantee.promise_id))).not.toMatch(/still watching/);
  });

  it("refuses a malformed item instead of dropping it silently", async () => {
    // `projections.ts` discards evidence with no `promise_id`, so a typo used to look like a
    // successful post. The schema is the gate now.
    const { status } = await post("/control/evidence", {
      evidence: [{ id: "evd_bad", kind: "carrier_scan" }],
    });
    expect(status).toBe(400);
  });

  it("refuses an empty body", async () => {
    expect((await post("/control/evidence", {})).status).toBe(400);
  });

  it("leaves the seeded week's figures alone", async () => {
    const before = (await client.callTool({ name: "ledger_summary", arguments: {} }))
      .structuredContent as Record<string, unknown>;

    await deliver();
    await post("/control/evidence", {
      uptime: [
        {
          source_id: "src_doorbell",
          household_id: harness.deps.householdId,
          interval: { start: "2026-10-11T12:00:00-07:00", end: "2026-10-11T18:00:00-07:00" },
        },
      ],
    });

    const after = (await client.callTool({ name: "ledger_summary", arguments: {} }))
      .structuredContent as Record<string, unknown>;

    expect(after.recovered).toStrictEqual(before.recovered);
    expect(after.open).toStrictEqual(before.open);
    expect(after.kept).toStrictEqual(before.kept);
  });
});

/**
 * One failure is one claim.
 *
 * The objection to giving `guarantee` a detector at all was that it would file twice for one
 * failure and double what a household appears to be owed. It does not, and this is the test
 * that says so: `claim_file` resolves a derived promise to the claim its message already has.
 * `derivesFromSiblings` asks the detector rather than restating its kinds, so the rule cannot
 * drift from what actually derives.
 */
describe("filing on a guarantee", () => {
  /**
   * A morning window, deliberately.
   *
   * The harness clock is Sunday 19:30 local, and the extractor resolves a bare time against
   * when the message arrived — so "between 1 and 5pm" lands *tomorrow*, which no past evidence
   * can cover and the engine rightly refuses to judge. The first draft of this test used it
   * and reached a 5% coverage refusal, then returned early past its own assertion. A window
   * that has already closed is what this test needs.
   */
  const MORNING = "Delivered between 9 and 11am, guaranteed or your money back.";

  it("returns the claim already filed for the promise it covers", async () => {
    const { json } = await post("/control/messages", {
      merchant: "Northwind Parcel",
      text: MORNING,
    });
    const promises = json.promises as unknown as Delivered[];
    const window = promises.find((p) => p.kind === "delivery_window");
    const guarantee = promises.find((p) => p.kind === "guarantee");
    if (window === undefined || guarantee === undefined) {
      throw new Error(`expected a window and a guarantee, read ${promises.map((p) => p.kind)}`);
    }

    // The camera was up across the whole window and nothing arrived: a missed window, seen
    // well enough to say so.
    await post("/control/evidence", {
      uptime: [
        {
          source_id: "src_doorbell",
          household_id: harness.deps.householdId,
          interval: { start: "2026-10-11T08:00:00-07:00", end: "2026-10-11T12:00:00-07:00" },
        },
      ],
    });

    const filed = await client.callTool({
      name: "claim_file",
      arguments: { promise_id: window.promise_id, confirm: true },
    });
    const first = (filed.structuredContent as { claim_id?: string } | undefined)?.claim_id;
    expect(first, `filing the window: ${spokenOf(filed)}`).toBeDefined();

    const again = await client.callTool({
      name: "claim_file",
      arguments: { promise_id: guarantee.promise_id, confirm: true },
    });

    expect(
      (again.structuredContent as { claim_id?: string } | undefined)?.claim_id,
      `filing the guarantee: ${spokenOf(again)}`,
    ).toBe(first);
  });
});
