import {
  BreachKindSchema as DomainBreachKind,
  RemedyFormSchema as DomainRemedyForm,
  MAX_NEGOTIATION_ROUNDS,
} from "@owed/domain";
import { BreachKindSchema as PolicyBreachKind } from "@owed/policy-library";
import {
  DEFAULT_MAX_ROUNDS as PROTOCOL_MAX_ROUNDS,
  RemedyFormSchema as ProtocolRemedyForm,
} from "@owed/recourse-protocol";
import { VIEW_NAMES } from "@owed/ui-views";
import { describe, expect, it } from "vitest";
import { VIEW_URIS } from "./views.js";

/**
 * Two schemas are deliberately declared twice. Nothing stopped them drifting.
 *
 * `policy-library/src/schema.ts:10-12` explains the duplication and it is the right
 * call: the library is meant to be useful on its own, and `@owed/domain` is
 * `private: true`, so importing the canonical enum would make a publishable package
 * depend on an unpublishable one. `recourse-protocol` redeclares `RemedyFormSchema` for
 * the same reason — and on purpose keeps `breach_kind` as an open `z.string()`, because a
 * wire protocol should not enumerate the claimant's taxonomy.
 *
 * So the copies stay. What was missing is anything asserting they agree. These are the
 * values that decide what a household is owed and in what form, split across the two
 * packages the Open Source mini-challenge points at, and a member added on one side only
 * would have failed silently in whichever direction the value happened to travel.
 *
 * This file lives in `mcp-server` because it is the only package that can see all three.
 */

/** zod v4 keeps the members on `.options`; compared as sets, since order is not a contract. */
const members = (schema: { options: readonly string[] }) => [...schema.options].sort();

describe("schemas that are declared twice on purpose", () => {
  it("agrees on what counts as a broken promise, across domain and policy-library", () => {
    expect(members(PolicyBreachKind)).toStrictEqual(members(DomainBreachKind));
  });

  it("agrees on the forms a remedy can take, across domain and recourse-protocol", () => {
    expect(members(ProtocolRemedyForm)).toStrictEqual(members(DomainRemedyForm));
  });

  it("still parses on both sides for every member, not just the same list of strings", () => {
    // Equal `.options` could in principle coexist with different refinements, so each
    // value is round-tripped through both schemas rather than compared as text.
    for (const kind of members(DomainBreachKind)) {
      expect(DomainBreachKind.safeParse(kind).success).toBe(true);
      expect(PolicyBreachKind.safeParse(kind).success).toBe(true);
    }
    for (const form of members(DomainRemedyForm)) {
      expect(DomainRemedyForm.safeParse(form).success).toBe(true);
      expect(ProtocolRemedyForm.safeParse(form).success).toBe(true);
    }
  });

  it("agrees on which views exist, across ui-views and the server that registers them", () => {
    // `@owed/ui-views` names the views it builds; `views.ts` owns the `ui://` URI each is
    // served under. The barrel's comment claims they agree, so this checks it rather than
    // leaving a reader to take the comment's word.
    expect([...VIEW_NAMES].sort()).toStrictEqual(Object.keys(VIEW_URIS).sort());
    for (const name of VIEW_NAMES) {
      expect(VIEW_URIS[name]).toBe(`ui://owed/${name}`);
    }
  });

  it("agrees on the negotiation round cap, across the domain and the protocol", () => {
    // Written out three times with the same value: `domain/src/coverage.ts`,
    // `core/src/negotiation/negotiator.ts` and `recourse-protocol/src/session.ts`. Core's
    // now re-exports the domain's, which leaves two — and the protocol's has to stay,
    // because it is a published package and `@owed/domain` is private. So this pins them.
    //
    // It matters: the claimant deciding to stop arguing at a different round from the
    // session that cuts the exchange off would strand a negotiation mid-sentence.
    expect(PROTOCOL_MAX_ROUNDS).toBe(MAX_NEGOTIATION_ROUNDS);
  });

  it("rejects a value neither side knows, so the test would catch a one-sided addition", () => {
    expect(DomainBreachKind.safeParse("teleported_delivery").success).toBe(false);
    expect(PolicyBreachKind.safeParse("teleported_delivery").success).toBe(false);
  });
});
