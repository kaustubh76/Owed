import { PromiseKindSchema } from "@owed/domain";
import type { ExtractionInput } from "@owed/extractor";
import { describe, expect, it } from "vitest";
import { createBedrockExtractor } from "./extract.js";
import type { Invoke } from "./invoke.js";
import { buildPrompt, PROMPT_KINDS } from "./prompt.js";

const MESSAGE: ExtractionInput = {
  id: "msg-1",
  merchant: "Northwind Parcel",
  received_at: "2026-10-05T16:00:00.000Z",
  utc_offset: "-07:00",
  subject: "Your delivery is on the way",
  body: "We will deliver your parcel between 1pm and 5pm on Tuesday 6 October.",
};

const QUOTE = "We will deliver your parcel between 1pm and 5pm on Tuesday 6 October.";

/** A plain function, following this repo's habit of real stand-ins over mocking libraries. */
function replying(raw: string): Invoke {
  return () => Promise.resolve(raw);
}

describe("the prompt", () => {
  /**
   * The prompt names the kinds as strings, so it cannot import them from the schema. This
   * is the guard against the copy drifting — a kind renamed in the domain would otherwise
   * leave the prompt asking for a value `parse.ts` then rejects, which would look like a
   * model failure.
   */
  it("names exactly the kinds the domain defines", () => {
    expect([...PROMPT_KINDS].sort()).toEqual([...PromiseKindSchema.options].sort());
  });

  it("gives the model the clock it needs to resolve relative dates", () => {
    const prompt = buildPrompt(MESSAGE);
    expect(prompt).toContain(MESSAGE.received_at);
    expect(prompt).toContain(MESSAGE.utc_offset);
  });

  it("includes the subject and body it is asking about", () => {
    const prompt = buildPrompt(MESSAGE);
    expect(prompt).toContain(MESSAGE.subject);
    expect(prompt).toContain(MESSAGE.body);
  });

  /** A quarter of the corpus promises nothing; a prompt that implies otherwise invents. */
  it("tells the model that nothing is a valid answer", () => {
    expect(buildPrompt(MESSAGE)).toMatch(/promise NOTHING/);
  });

  it("demands the quote verbatim, since that is what the guard enforces", () => {
    expect(buildPrompt(MESSAGE)).toMatch(/CHARACTER FOR CHARACTER/);
  });
});

describe("the extractor", () => {
  it("returns what the parser kept", async () => {
    const extract = createBedrockExtractor({
      invoke: replying(
        JSON.stringify([
          {
            kind: "delivery_window",
            confidence: 0.9,
            deadline: "2026-10-07T00:00:00Z",
            evidence_text: QUOTE,
          },
        ]),
      ),
    });
    const result = await extract(MESSAGE);
    expect(result).toHaveLength(1);
    expect(result[0]?.kind).toBe("delivery_window");
  });

  it("passes the built prompt through to invoke", async () => {
    const seen: string[] = [];
    const extract = createBedrockExtractor({
      invoke: (prompt) => {
        seen.push(prompt);
        return Promise.resolve("[]");
      },
    });
    await extract(MESSAGE);
    expect(seen[0]).toBe(buildPrompt(MESSAGE));
  });

  it("reports dropped extractions to the caller", async () => {
    const reasons: string[] = [];
    const extract = createBedrockExtractor({
      invoke: replying(
        JSON.stringify([
          {
            kind: "eta",
            confidence: 0.9,
            deadline: "2026-10-07T00:00:00Z",
            evidence_text: "Words nobody wrote.",
          },
        ]),
      ),
      onDropped: (_input, dropped) => reasons.push(...dropped),
    });

    expect(await extract(MESSAGE)).toEqual([]);
    expect(reasons[0]).toMatch(/not in the message/);
  });

  /**
   * An empty array is a real answer here, so a failed call must not look like one. If it
   * did, a network outage would score as a cautious extractor: perfect on the negatives,
   * missing everything else.
   */
  it("propagates a failed call rather than returning nothing", async () => {
    const extract = createBedrockExtractor({
      invoke: () => Promise.reject(new Error("AccessDeniedException")),
    });
    await expect(extract(MESSAGE)).rejects.toThrow(/AccessDenied/);
  });
});
