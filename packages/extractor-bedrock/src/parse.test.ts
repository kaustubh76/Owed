import type { ExtractionInput } from "@owed/extractor";
import { describe, expect, it } from "vitest";
import { parseExtractions } from "./parse.js";

/**
 * The model is not here, and does not need to be. Everything that decides whether a
 * model-backed extractor is trustworthy happens after the reply arrives, so these are real
 * tests of the real code path with a real string — not a stand-in for tests that would be
 * written later against the service.
 */
const MESSAGE: ExtractionInput = {
  id: "msg-1",
  merchant: "Northwind Parcel",
  received_at: "2026-10-05T16:00:00.000Z",
  utc_offset: "-07:00",
  subject: "Your delivery is on the way",
  body: "We will deliver your parcel between 1pm and 5pm on Tuesday 6 October.\nIf we miss that window you are owed £8 under our Delivery Guarantee 4.1.",
};

const GOOD_QUOTE = "We will deliver your parcel between 1pm and 5pm on Tuesday 6 October.";

function reply(...items: unknown[]): string {
  return JSON.stringify(items);
}

describe("the evidence guard", () => {
  /**
   * The reason this package can exist without weakening the product. `quoteFor()` in the
   * server's seed shows the extractor's quote on the evidence card under *they wrote* — so
   * a quote the merchant did not write would be invented words attributed to a real
   * company, supporting a real claim for money.
   */
  it("discards an extraction whose quote is not in the message", () => {
    const result = parseExtractions(
      reply({
        kind: "delivery_window",
        confidence: 0.9,
        window: { start: "2026-10-06T20:00:00Z", end: "2026-10-07T00:00:00Z" },
        evidence_text: "We guarantee delivery before noon, no exceptions whatsoever.",
      }),
      MESSAGE,
    );

    expect(result.extractions).toEqual([]);
    expect(result.dropped[0]).toMatch(/not in the message/);
  });

  it("keeps one whose quote is there verbatim", () => {
    const result = parseExtractions(
      reply({
        kind: "delivery_window",
        confidence: 0.9,
        window: { start: "2026-10-06T20:00:00Z", end: "2026-10-07T00:00:00Z" },
        evidence_text: GOOD_QUOTE,
      }),
      MESSAGE,
    );

    expect(result.dropped).toEqual([]);
    expect(result.extractions).toHaveLength(1);
    expect(result.extractions[0]?.evidence_text).toBe(GOOD_QUOTE);
  });

  /** A model that re-wrapped a line it copied correctly has not invented anything. */
  it("forgives re-wrapped whitespace", () => {
    const rewrapped = GOOD_QUOTE.replace(" between", "\n  between");
    const result = parseExtractions(
      reply({
        kind: "delivery_window",
        confidence: 0.8,
        deadline: "2026-10-07T00:00:00Z",
        evidence_text: rewrapped,
      }),
      MESSAGE,
    );
    expect(result.extractions).toHaveLength(1);
  });

  /** But nothing beyond whitespace, or the guard stops being a guard. */
  it("does not forgive a paraphrase", () => {
    const result = parseExtractions(
      reply({
        kind: "delivery_window",
        confidence: 0.8,
        deadline: "2026-10-07T00:00:00Z",
        evidence_text: "We will deliver your parcel between 1 pm and 5 pm on Tuesday.",
      }),
      MESSAGE,
    );
    expect(result.extractions).toEqual([]);
  });

  it("finds a quote taken from the subject line", () => {
    const result = parseExtractions(
      reply({
        kind: "eta",
        confidence: 0.5,
        deadline: "2026-10-07T00:00:00Z",
        evidence_text: "Your delivery is on the way",
      }),
      MESSAGE,
    );
    expect(result.extractions).toHaveLength(1);
  });

  /** One invented quote must not take a good extraction down with it. */
  it("drops only the invented one", () => {
    const result = parseExtractions(
      reply(
        {
          kind: "delivery_window",
          confidence: 0.9,
          deadline: "2026-10-07T00:00:00Z",
          evidence_text: GOOD_QUOTE,
        },
        {
          kind: "guarantee",
          confidence: 0.9,
          deadline: "2026-10-07T00:00:00Z",
          evidence_text: "Free returns forever.",
        },
      ),
      MESSAGE,
    );
    expect(result.extractions).toHaveLength(1);
    expect(result.extractions[0]?.kind).toBe("delivery_window");
    expect(result.dropped).toHaveLength(1);
  });
});

describe("replies that are not what was asked for", () => {
  it("recovers JSON from inside markdown fences", () => {
    const raw = `Here is what I found:\n\`\`\`json\n${reply({
      kind: "delivery_window",
      confidence: 0.9,
      deadline: "2026-10-07T00:00:00Z",
      evidence_text: GOOD_QUOTE,
    })}\n\`\`\``;
    expect(parseExtractions(raw, MESSAGE).extractions).toHaveLength(1);
  });

  it("treats an empty array as the real answer it is", () => {
    // A quarter of the corpus promises nothing. This must not look like a failure.
    const result = parseExtractions("[]", MESSAGE);
    expect(result.extractions).toEqual([]);
    expect(result.dropped).toEqual([]);
  });

  it("reports, rather than throws, on prose with no JSON at all", () => {
    const result = parseExtractions("I could not find any promises in this message.", MESSAGE);
    expect(result.extractions).toEqual([]);
    expect(result.dropped).toEqual(["reply contained no JSON array"]);
  });

  /** Bracketed but broken inside — the array is found, then fails to parse. */
  it("reports malformed JSON", () => {
    expect(parseExtractions('[{"kind": }]', MESSAGE).dropped[0]).toMatch(/not valid JSON/);
  });

  /**
   * Truncated output — a real mode when a reply hits the token limit — has no closing
   * bracket, so it never reaches the parser. A different message for a different fault.
   */
  it("reports a truncated reply as having no array", () => {
    expect(parseExtractions('[{"kind": "eta", ', MESSAGE).dropped).toEqual([
      "reply contained no JSON array",
    ]);
  });

  it("reports a JSON object where an array was asked for", () => {
    expect(parseExtractions('{"kind":"eta"}', MESSAGE).dropped).toEqual([
      "reply contained no JSON array",
    ]);
  });
});

describe("schema violations", () => {
  it("drops an unknown promise kind", () => {
    const result = parseExtractions(
      reply({
        kind: "free_shipping",
        confidence: 0.9,
        deadline: "2026-10-07T00:00:00Z",
        evidence_text: GOOD_QUOTE,
      }),
      MESSAGE,
    );
    expect(result.extractions).toEqual([]);
    expect(result.dropped[0]).toMatch(/failed schema/);
  });

  it("drops a confidence outside 0..1", () => {
    const result = parseExtractions(
      reply({
        kind: "eta",
        confidence: 1.5,
        deadline: "2026-10-07T00:00:00Z",
        evidence_text: GOOD_QUOTE,
      }),
      MESSAGE,
    );
    expect(result.extractions).toEqual([]);
  });

  /** `normalizeInstant` throws on an unparsable date, so this must be caught by the schema. */
  it("drops an unparseable date without throwing", () => {
    const result = parseExtractions(
      reply({
        kind: "eta",
        confidence: 0.9,
        deadline: "next Tuesday-ish",
        evidence_text: GOOD_QUOTE,
      }),
      MESSAGE,
    );
    expect(result.extractions).toEqual([]);
    expect(result.dropped[0]).toMatch(/failed schema/);
  });

  it("drops an extraction with no timing at all", () => {
    const result = parseExtractions(
      reply({ kind: "guarantee", confidence: 0.9, evidence_text: GOOD_QUOTE }),
      MESSAGE,
    );
    expect(result.dropped[0]).toMatch(/neither window nor deadline/);
  });

  it("drops an extraction claiming both a window and a deadline", () => {
    const result = parseExtractions(
      reply({
        kind: "delivery_window",
        confidence: 0.9,
        window: { start: "2026-10-06T20:00:00Z", end: "2026-10-07T00:00:00Z" },
        deadline: "2026-10-07T00:00:00Z",
        evidence_text: GOOD_QUOTE,
      }),
      MESSAGE,
    );
    expect(result.dropped[0]).toMatch(/both a window and a deadline/);
  });

  it("keeps extra fields the model volunteered", () => {
    const result = parseExtractions(
      reply({
        kind: "eta",
        confidence: 0.9,
        deadline: "2026-10-07T00:00:00Z",
        evidence_text: GOOD_QUOTE,
        reasoning: "the merchant states a window",
      }),
      MESSAGE,
    );
    expect(result.extractions).toHaveLength(1);
  });
});

describe("instants", () => {
  /**
   * The harness compares timing by exact string equality with no tolerance, so a correct
   * answer written in the merchant's own offset would otherwise read as a miss.
   */
  it("normalizes an offset instant to UTC so it can compare equal", () => {
    const result = parseExtractions(
      reply({
        kind: "delivery_window",
        confidence: 0.9,
        window: { start: "2026-10-06T13:00:00-07:00", end: "2026-10-06T17:00:00-07:00" },
        evidence_text: GOOD_QUOTE,
      }),
      MESSAGE,
    );
    expect(result.extractions[0]?.window).toEqual({
      start: "2026-10-06T20:00:00.000Z",
      end: "2026-10-07T00:00:00.000Z",
    });
  });
});
