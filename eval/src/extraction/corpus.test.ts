import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EXTRACTION_PARAMETERS, generateExtractionCorpus, type LabelledMessage } from "./corpus.js";
import { heldOutMessages } from "./heldout.js";
import { measureExtraction } from "./measure.js";

const committed = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../../data/corpus/extraction.json", import.meta.url)),
    "utf8",
  ),
) as { parameters: Record<string, unknown>; size: number; messages: LabelledMessage[] };

/** Pre-registration, enforced — the same protection the grid and the breach corpus get. */
describe("the pre-registered extraction corpus", () => {
  it("still matches the generator, message for message", () => {
    expect(committed.parameters).toEqual(JSON.parse(JSON.stringify(EXTRACTION_PARAMETERS)));
    expect(committed.size).toBe(120);
    expect(committed.messages).toEqual(JSON.parse(JSON.stringify(generateExtractionCorpus())));
  });

  it("still splits evenly between templated and prose", () => {
    for (const set of EXTRACTION_PARAMETERS.sets) {
      expect(committed.messages.filter((m) => m.set === set).length).toBe(60);
    }
  });

  /**
   * The half that decides precision. Without messages that promise nothing, an extractor
   * reaches perfect recall by reading every number as a commitment and nothing catches it.
   */
  it("still contains messages that promise nothing at all", () => {
    const negatives = committed.messages.filter((m) => m.expected.length === 0);
    expect(negatives.length).toBeGreaterThanOrEqual(25);
    expect(negatives.every((m) => m.set === "authored")).toBe(true);
  });

  it("still covers all seven promise kinds", () => {
    const seen = new Set(committed.messages.flatMap((m) => m.expected.map((e) => e.kind)));
    for (const kind of EXTRACTION_PARAMETERS.kinds) expect(seen.has(kind)).toBe(true);
  });

  /**
   * Every case says what it is for. A templated message can be a tag — "working days",
   * "named weekday" — because the message itself shows the reader what is being tested.
   * An authored one cannot: the label is a judgement about prose, so it has to be argued.
   */
  it("says what every case is testing", () => {
    for (const item of committed.messages) {
      expect(item.note.length).toBeGreaterThanOrEqual(item.set === "authored" ? 12 : 4);
    }
  });
});

describe("what the corpus measures", () => {
  const report = measureExtraction(generateExtractionCorpus());

  /**
   * Reading a promise out of a marketing email is the failure that would make Owed
   * unusable: it would file claims nobody was ever owed. Asserted rather than merely
   * reported, because unlike the thresholds this is not a hypothesis — it is a floor.
   */
  it("reads nothing out of a message that promises nothing", () => {
    expect(report.false_alarms).toEqual([]);
  });

  /** Deliberately asserts no threshold. H1 is reported in eval/README.md, met or not. */
  it("reports a number for every promise kind", () => {
    for (const kind of EXTRACTION_PARAMETERS.kinds) {
      expect(report.kind.by_kind[kind]).toBeDefined();
    }
  });
});

describe("the held-out set", () => {
  const committedHeldOut = JSON.parse(
    readFileSync(
      fileURLToPath(new URL("../../../data/corpus/extraction-heldout.json", import.meta.url)),
      "utf8",
    ),
  ) as { size: number; messages: LabelledMessage[] };

  /**
   * Pinned for the opposite reason to the corpus next door.
   *
   * That one is pinned so its cases cannot be softened. This one is pinned so it cannot
   * be *used*: the moment a message here is reworded to suit the extractor, or quietly
   * dropped because it fails, the only number in this repository that was not fitted
   * stops being one. Its value is entirely that the extractor has never been changed
   * because of it.
   */
  it("still matches the generator, message for message", () => {
    expect(committedHeldOut.size).toBe(40);
    expect(committedHeldOut.messages).toEqual(JSON.parse(JSON.stringify(heldOutMessages())));
  });

  it("still speaks in voices the tuned corpus does not", () => {
    const negatives = committedHeldOut.messages.filter((m) => m.expected.length === 0);
    expect(negatives.length).toBeGreaterThanOrEqual(15);
  });

  /**
   * Asserts the gap exists rather than asserting a score.
   *
   * If held-out performance ever matched the tuned corpus, either the extractor got
   * genuinely better or this set got used. The first would be good news and this test
   * would be deleted deliberately; the second is what it is here to make noisy.
   */
  it("still scores below the corpus the extractor was tuned against", () => {
    const tuned = measureExtraction(generateExtractionCorpus());
    const held = measureExtraction(heldOutMessages());
    expect(held.kind.overall.recall ?? 0).toBeLessThan(tuned.kind.overall.recall ?? 0);
  });
});
