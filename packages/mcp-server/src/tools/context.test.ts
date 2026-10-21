import { describe, expect, it } from "vitest";
import { UnspeakableTextError } from "../voice.js";
import { spokenError } from "./context.js";

/**
 * The refusal path, which was the one spoken line nothing checked.
 *
 * `voice.ts` says of `assertSpeakable`: "This runs on every tool result rather than only in
 * tests." Every `speak*` function on the success path was guarded; `spokenError` was not, so
 * a refusal composed from ledger state could carry a digit, a URL, a tool name or JSON to a
 * voice-only device — which `alexa/contract.test.ts` quotes Amazon forbidding verbatim.
 *
 * It had already happened once: a `ProtocolViolation` from a merchant agent reached the
 * household as raw exception text, because the tool handler rethrew and the message became
 * `content[0].text`. That path was fixed where it arose; this closes the shape of it.
 */
describe("a spoken refusal", () => {
  it("passes a sentence through unchanged", () => {
    const text = "All right, I won't file it.";
    expect(spokenError(text).content[0]?.text).toBe(text);
  });

  it("is an error result, so the host knows not to act on it", () => {
    expect(spokenError("I don't have that promise.").isError).toBe(true);
  });

  /** The four things Amazon's sentence forbids, each refused rather than spoken. */
  it.each([
    ["a digit", "Northwind Parcel owes you 8 dollars."],
    ["a tool name and JSON", 'claim_file failed: {"promise_id":"prm_011"}'],
    ["a URL", "See https://example.com/claims for details."],
    ["an identifier", "No claim clm_011 in this ledger."],
  ])("refuses to speak %s", (_what, text) => {
    expect(() => spokenError(text)).toThrow(UnspeakableTextError);
  });

  it("refuses an empty line, which says nothing at all", () => {
    expect(() => spokenError("")).toThrow(UnspeakableTextError);
  });
});
