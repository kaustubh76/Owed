import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { project } from "@owed/core";
import type { LedgerEvent } from "@owed/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Harness, startHarness } from "../testing/harness.js";

/**
 * Why Owed will not chase a household's money, said out loud.
 *
 * §2 gates a breach on **two** numbers: `confidence >= 0.85` *and* `coverage >= 0.7`. Fail
 * either and the verdict is `Suspected`, and `claim_file` refuses to file it. Every sentence
 * explaining that refusal named coverage — "I only watched twenty percent of the window. That
 * isn't enough to say it was broken" — and none of them looked at confidence.
 *
 * They were true anyway, by an arithmetic coincidence nobody had written down:
 * `confidenceFromCoverage(0.7)` is exactly `0.85`, so for the two coverage-derived detectors the
 * gates fail together, and every fixed-confidence detector sits at 0.9 or above. So the sentence
 * was right for a reason that had nothing to do with the sentence, and moving
 * `BREACH_CONFIDENCE_MIN`, `GAP_CREDIBILITY` or adding a detector at 0.8 would have had Owed say
 * "I only watched ninety-five percent of the window. That isn't enough" — about money, to a
 * household, with every gate green.
 *
 * Both branches are asserted here. The coverage one had **no test at all**, despite being the
 * demo's trust beat and quoted verbatim in `docs/demo-capture.json`; the confidence one is
 * unreachable through the shipped detectors, so it is reached by appending an assessment, which
 * is the only honest way to drive a gate the reference detectors cannot fail on their own.
 */

/** The seeded promise the storyboard declines: a camera that was up for a fifth of the window. */
const DECLINED = "prm_010";

let harness: Harness;
let client: Client;

beforeEach(async () => {
  harness = await startHarness();
  const token = await harness.link();
  client = new Client({ name: "claim-file-refusal-test", version: "1.0.0" });
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

const spokenOf = (result: { content: unknown }): string =>
  (result.content as Array<{ text?: string }>)[0]?.text ?? "";

const fileIt = (promiseId: string) =>
  client.callTool({ name: "claim_file", arguments: { promise_id: promiseId, confirm: true } });

describe("refusing to file, and saying which gate refused", () => {
  it("blames the window when the window is what failed", async () => {
    const spoken = spokenOf(await fileIt(DECLINED));

    expect(spoken).toBe(
      "I won't file that one. I only watched twenty percent of the window. That isn't enough " +
        "to say it was broken.",
    );
  });

  /**
   * The same promise, re-assessed with the window fully watched and the verdict still unsure.
   *
   * Built from the assessment already in the ledger so the fixture cannot drift from the real
   * shape, with `observed` widened to the whole interval so the coverage it claims is coherent
   * with what it says it saw. Appended rather than detected, because no shipped detector reports
   * `broken` below the confidence gate — which is exactly why this sentence had never run.
   */
  it("blames its own certainty when the window was watched and it still is not sure", async () => {
    const before = project(await harness.deps.store.read(harness.deps.householdId));
    const assessment = before.promises.get(DECLINED)?.assessment;
    if (assessment === undefined) throw new Error(`${DECLINED} has no assessment to rebuild`);

    const now = harness.clock.now();
    const unsure: LedgerEvent = {
      id: "evt_unsure",
      household_id: harness.deps.householdId,
      occurred_at: now,
      recorded_at: now,
      type: "PromiseAssessed",
      assessment: {
        ...assessment,
        confidence: 0.5,
        coverage: 0.95,
        observed: [assessment.evaluation_interval],
      },
    };
    await harness.deps.store.append([unsure]);

    const spoken = spokenOf(await fileIt(DECLINED));

    expect(spoken).toBe(
      "I won't file that one. I saw enough of the window, but I'm not sure enough that it was " +
        "broken.",
    );
    // The point of the change: it no longer reports a window it was happy with as the reason.
    expect(spoken, "ninety-five percent of the window was plenty").not.toMatch(/percent/);
    expect(spoken, "a spoken line carries no digits").not.toMatch(/[0-9]/);
  });
});
