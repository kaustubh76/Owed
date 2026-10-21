import { BreachKindSchema as DomainBreachKinds } from "@owed/domain";
import { BreachKindSchema as PolicyBreachKinds } from "@owed/policy-library";
import { describe, expect, it } from "vitest";

/**
 * The one duplicated enum in the workspace, and why it has to stay duplicated.
 *
 * `@owed/policy-library` declares its own `BreachKindSchema` instead of importing
 * `@owed/domain`'s, and `schema.ts` says why in its header: "kept independent of the
 * claimant's domain package so the library is useful on its own — the breach kinds are
 * redeclared here and interoperate structurally". That is a real constraint rather than an
 * oversight. `@owed/domain` is `private: true`, so importing it would cost the policy library
 * the liftability `readme.md` §15 claims for it, which `pnpm verify:graph` now checks.
 *
 * So the duplication cannot be removed, which means it needs a guard — the same reasoning
 * that put the duplicated IAM policy under `verify:deploy`. Drift here is silent and
 * expensive: domain gains a breach kind, `remedyFor` has no case for it, and no claim is ever
 * argued for a failure Owed detected perfectly well.
 *
 * This test lives in `mcp-server` because it is the only package that depends on both, and
 * because a test inside `policy-library` would have to take a dev dependency on the private
 * package the separation exists to avoid.
 */
describe("the breach kinds, declared twice on purpose", () => {
  it("agree exactly, in order", () => {
    expect(PolicyBreachKinds.options).toStrictEqual(DomainBreachKinds.options);
  });

  it("are the six the contract freezes", () => {
    expect(DomainBreachKinds.options).toStrictEqual([
      "late_eta",
      "missed_window",
      "phantom_delivery",
      "no_show",
      "late_refund",
      "price_drop",
    ]);
  });

  /**
   * Structural interoperation is the whole point of the redeclaration, so it is asserted
   * rather than assumed: every kind one accepts, the other accepts.
   */
  it("accept each other's values", () => {
    for (const kind of DomainBreachKinds.options) {
      expect(PolicyBreachKinds.safeParse(kind).success, kind).toBe(true);
    }
    for (const kind of PolicyBreachKinds.options) {
      expect(DomainBreachKinds.safeParse(kind).success, kind).toBe(true);
    }
  });
});
