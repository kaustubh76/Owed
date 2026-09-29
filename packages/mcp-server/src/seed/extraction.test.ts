import { extractPromises } from "@owed/extractor";
import { describe, expect, it } from "vitest";
import { buildArcs, SOURCE_MESSAGES } from "./storyboard.js";

/**
 * The provenance chain, checked end to end.
 *
 * Every seeded promise says it came from a message — `source_ref: msg_prm_004` — and
 * for most of this project's life there was nothing on the other end of that reference.
 * A card that shows a household "Northwind Parcel promised 1pm to 5pm" is only worth
 * anything if those words were somewhere a person could point at.
 *
 * So the real extractor is run over the real message and has to land on the same
 * promise, to the minute. Nothing is stubbed and no timing is rounded. If a message is
 * reworded so it no longer says what the promise claims, this goes red.
 */
describe("every seeded promise can be read out of the message it came from", () => {
  const arcs = buildArcs();

  it("has a message behind every promise", () => {
    for (const arc of arcs) {
      expect(SOURCE_MESSAGES[arc.promise.id], `no message for ${arc.promise.id}`).toBeDefined();
      expect(arc.promise.source_ref).toBe(`msg_${arc.promise.id}`);
    }
  });

  for (const arc of arcs) {
    const promise = arc.promise;
    it(`recovers ${promise.id} — ${promise.merchant}, ${promise.kind}`, () => {
      const message = SOURCE_MESSAGES[promise.id];
      if (message === undefined) throw new Error(`no message for ${promise.id}`);

      const read = extractPromises({
        id: `msg_${promise.id}`,
        merchant: promise.merchant,
        // Resolved against when the merchant sent it, which is what "tomorrow" means.
        received_at: promise.made_at,
        utc_offset: "-07:00",
        subject: message.subject,
        body: message.body,
      });

      const match = read.find((item) => item.kind === promise.kind);
      expect(match, `read ${read.map((r) => r.kind).join(", ") || "nothing"}`).toBeDefined();

      if (promise.window !== undefined) {
        expect(match?.window).toEqual(promise.window);
      } else if (promise.deadline !== undefined) {
        expect(match?.deadline).toBe(promise.deadline);
      }
    });
  }
});
