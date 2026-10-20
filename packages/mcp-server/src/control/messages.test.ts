import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { TRACKING_CONFIDENCE } from "@owed/core";
import { LedgerSummaryViewSchema } from "@owed/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Harness, startHarness } from "../testing/harness.js";

/**
 * Delivering a message, and what Owed makes of it.
 *
 * The extraction pipeline was built and nothing ran it: the seeded week writes its
 * promises in directly and used the extractor only to recover the sentence behind one of
 * them. So `PromiseStatus`'s `Candidate` and `Captured`, both of which have had a label
 * and a sort rank in `ui-views` since they were declared, had no producer anywhere.
 *
 * These go through the real endpoint with the real rules extractor, on real sentences,
 * because the thing worth checking is not the mapping — `core/src/ledger/capture.test.ts`
 * does that — but that both statuses are reachable from something a merchant would
 * actually write. A threshold no real message crosses would be decoration.
 */

let harness: Harness;

beforeEach(async () => {
  harness = await startHarness();
});

afterEach(async () => {
  await harness?.close();
});

interface Delivered {
  received_at: string;
  message_id: string;
  tracking_confidence: number;
  promises: Array<{
    promise_id: string;
    kind: string;
    status: string;
    confidence: number;
    promised_in?: string;
  }>;
}

async function deliver(body: unknown): Promise<{ status: number; json: Delivered }> {
  const response = await fetch(new URL("/control/messages", harness.baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: (await response.json()) as Delivered };
}

describe("POST /control/messages", () => {
  it("tracks a promise a merchant stated plainly", async () => {
    const { status, json } = await deliver({
      merchant: "Northwind Parcel",
      subject: "Your order is on its way",
      text: "Your parcel will arrive on Tuesday between 1pm and 5pm.",
    });

    expect(status).toBe(200);
    expect(json.tracking_confidence).toBe(TRACKING_CONFIDENCE);
    expect(json.promises).toHaveLength(1);
    expect(json.promises[0]?.kind).toBe("delivery_window");
    expect(json.promises[0]?.status).toBe("Captured");
    expect(json.promises[0]?.confidence).toBeGreaterThanOrEqual(TRACKING_CONFIDENCE);
  });

  /**
   * A real sentence from the pre-registered corpus (`g_ref_5`), which the rules extractor
   * reads at 0.82 — the cue is not adjacent to the duration it qualifies.
   */
  it("records a promise it is less sure of without tracking it", async () => {
    const { json } = await deliver({
      merchant: "Calder & Co.",
      subject: "Returns",
      text: "You can return anything within 30 days for a full refund.",
    });

    expect(json.promises).toHaveLength(1);
    expect(json.promises[0]?.kind).toBe("refund_sla");
    expect(json.promises[0]?.status).toBe("Candidate");
    expect(json.promises[0]?.confidence).toBeLessThan(TRACKING_CONFIDENCE);
  });

  /**
   * One message, both statuses — `g_gua_4` from the corpus. The window is stated and the
   * guarantee is inferred from it, so Owed tracks the first and merely records the second.
   * This is the case that makes the distinction worth having at all.
   */
  it("keeps a stated promise and an inferred one apart within one message", async () => {
    const { json } = await deliver({
      merchant: "Northwind Parcel",
      subject: "Delivery promise",
      text: "Delivered between 1 and 5pm, guaranteed or your money back.",
    });

    const byKind = new Map(json.promises.map((promise) => [promise.kind, promise.status]));
    expect(byKind.get("delivery_window")).toBe("Captured");
    expect(byKind.get("guarantee")).toBe("Candidate");
  });

  /**
   * `g_eta_2` from the corpus. A relative duration — "arriving in ten minutes" — is read by
   * nothing: this extractor finds time expressions and classifies them by the words around
   * them, so an ETA has to name a time. That is a property of the rules extractor, not of
   * this endpoint, and the sentence here is one the corpus actually contains.
   */
  it("returns the sentence each promise was read out of", async () => {
    const { json } = await deliver({
      merchant: "Meridian Rides",
      text: "Your ride will arrive by 9pm.",
    });

    expect(json.promises[0]?.kind).toBe("eta");
    expect(json.promises[0]?.promised_in).toContain("by 9pm");
  });

  it("puts them in the ledger, where the tools can see them", async () => {
    const before = await harness.deps.store.read(harness.deps.householdId);
    const { json } = await deliver({
      merchant: "Northwind Parcel",
      text: "Your parcel will arrive on Tuesday between 1pm and 5pm.",
    });

    const after = await harness.deps.store.read(harness.deps.householdId);
    const promiseId = json.promises[0]?.promise_id;

    /**
     * Captured *and* judged, named rather than counted.
     *
     * This asserted `before.length + 1`, which was one event because delivering a message
     * only ever captured. The endpoint now runs the breach engine over what it captured —
     * the step that was missing, and the reason a live promise could never be judged — so
     * the count is two. Naming both events says what the endpoint does instead of how many
     * rows it happens to add, and it fails if either half stops happening.
     */
    const captured = after.find(
      (event) => event.type === "PromiseCaptured" && event.promise.id === promiseId,
    );
    expect(captured, "the promise reached the ledger").toBeDefined();

    const assessed = after.find(
      (event) => event.type === "PromiseAssessed" && event.assessment.promise_id === promiseId,
    );
    expect(assessed, "and the breach engine judged it").toBeDefined();
    // Exactly two: the capture and its verdict. A looser assertion here let a draft of the
    // re-assessment rule re-judge six seeded promises on every delivered message.
    expect(after.length).toBe(before.length + 2);
  });

  /**
   * The seeded week has to survive it. A delivered message adds to the ledger; it must not
   * disturb the figures the storyboard rests on, and the ids must not collide with the
   * seeded ones.
   */
  it("leaves the seeded week's figures alone", async () => {
    const token = await harness.link();
    const client = new Client({ name: "messages-test", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(harness.mcpUrl, {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }),
    );
    try {
      const before = LedgerSummaryViewSchema.parse(
        (await client.callTool({ name: "ledger_summary", arguments: {} })).structuredContent,
      );

      const { json } = await deliver({
        merchant: "Northwind Parcel",
        text: "Your parcel will arrive on Tuesday between 1pm and 5pm.",
      });
      expect(json.promises[0]?.promise_id).not.toMatch(/^prm_0{0,2}\d{1,3}$/);

      const after = LedgerSummaryViewSchema.parse(
        (await client.callTool({ name: "ledger_summary", arguments: {} })).structuredContent,
      );
      expect(after.recovered).toStrictEqual(before.recovered);
      expect(after.open).toStrictEqual(before.open);
      expect(after.kept).toBe(before.kept);
    } finally {
      await client.close();
    }
  });

  it("records nothing when the message promised nothing", async () => {
    const { status, json } = await deliver({
      merchant: "Northwind Parcel",
      subject: "Newsletter",
      text: "Thanks for shopping with us. Here is what is new this month.",
    });

    expect(status).toBe(200);
    expect(json.promises).toStrictEqual([]);
  });

  it("refuses a body without the two things it needs", async () => {
    for (const body of [{}, { merchant: "X" }, { text: "hello" }, { merchant: "", text: "x" }]) {
      const response = await fetch(new URL("/control/messages", harness.baseUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
  });
});

describe("claim_file on a promise Owed is not tracking", () => {
  it("says it is not sure the merchant promised it, rather than that it is still looking", async () => {
    const { json } = await deliver({
      merchant: "Calder & Co.",
      subject: "Returns",
      text: "You can return anything within 30 days for a full refund.",
    });
    const candidate = json.promises[0]?.promise_id;
    expect(candidate).toBeDefined();

    const token = await harness.link();
    const client = new Client({ name: "candidate-test", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(harness.mcpUrl, {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }),
    );
    try {
      const result = await client.callTool({
        name: "claim_file",
        arguments: { promise_id: candidate, confirm: true },
      });
      const spoken = (result.content as Array<{ text?: string }>)[0]?.text ?? "";

      expect(result.isError).toBe(true);
      expect(spoken).toContain("not tracking that one");
      expect(spoken).toContain("Calder & Co.");
      // The old refusal for a promise with no assessment, which would be untrue here:
      // Owed has finished looking, and the answer is that it is not sure.
      expect(spoken).not.toContain("haven't finished looking");
    } finally {
      await client.close();
    }
  });
});
