import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { builtinPolicies, PolicyParseError, parsePolicies } from "./load.js";
import { findClause, nothingOwed, remedyFor } from "./resolve.js";
import type { MerchantPolicy, Money } from "./schema.js";

const usd = (major: number): Money => ({ minor: Math.round(major * 100), currency: "USD" });
const library = builtinPolicies();
const policy = (merchant: string): MerchantPolicy => {
  const found = library.get(merchant);
  if (!found) throw new Error(`no policy for ${merchant}`);
  return found;
};

/**
 * The two helpers this package publishes and does not itself call.
 *
 * `policy-library` is a published, Apache-2.0 package, so an export with no internal
 * caller is not dead code — it is API surface a consumer is invited to rely on. Both of
 * these were untested and undocumented, which makes them a promise nobody checked.
 *
 * Neither has a natural call site inside Owed, and that is deliberate rather than an
 * oversight: where no clause applies, the add-on says so in words and stops
 * (`claimFile.ts:206`, `scheduler.ts:64`) instead of carrying a zero around. A consumer
 * building a table or a dashboard wants the typed zero; Owed wants the sentence.
 */
describe("the helpers a consumer of this library gets", () => {
  it("reports nothing owed in the policy's own currency, not a bare zero", () => {
    const northwind = policy("Northwind Parcel");
    const nothing = nothingOwed(northwind);

    expect(nothing.minor).toBe(0);
    // The currency is the point. A consumer formatting this must not have to guess, and
    // a zero with the wrong currency would format as the wrong symbol.
    expect(nothing.currency).toBe(northwind.currency);
  });

  it("finds a clause by the id its own policy document uses", () => {
    const northwind = policy("Northwind Parcel");
    const first = northwind.clauses[0];
    if (first === undefined) throw new Error("the shipped policy has no clauses");

    const found = findClause(northwind, first.id);
    expect(found?.id).toBe(first.id);
    // Returned whole, so a consumer can cite the title and the source it came from —
    // which is what makes a claim checkable against the merchant's own wording.
    expect(found?.title).toBe(first.title);
  });

  it("returns undefined for a clause the policy does not contain, rather than throwing", () => {
    expect(findClause(policy("Northwind Parcel"), "no-such-clause")).toBeUndefined();
  });

  it("finds every clause the shipped policies declare, by id", () => {
    // A lookup that works for one id and not the rest would pass the test above.
    // And an empty library would pass this one, which is why the count is asserted: the
    // four merchants are the ones the sibling test in "the shipped library" names.
    expect(library.merchants(), "shipped merchants").toHaveLength(4);

    for (const merchant of library.merchants()) {
      const p = policy(merchant);
      for (const clause of p.clauses) {
        expect(findClause(p, clause.id), `${merchant} ${clause.id}`).toBeDefined();
      }
    }
  });
});

describe("the shipped library", () => {
  it("loads every merchant in the storyboard", () => {
    expect(library.merchants()).toEqual([
      "Alder Home Services",
      "Calder & Co.",
      "Meridian Rides",
      "Northwind Parcel",
    ]);
  });

  /**
   * The product's claim is that it asserts only what a merchant itself promised. That
   * is only checkable if every clause says where it came from and quotes the wording,
   * so this is an invariant of the library rather than an editorial preference.
   */
  it("gives every clause a source and the merchant's own words", () => {
    // The product's claim is only as good as the number of clauses it actually holds for,
    // and this loop reported success over an empty library. Both levels are counted.
    const policies = library.all();
    expect(policies, "shipped policies").toHaveLength(4);
    expect(
      policies.flatMap((merchant) => merchant.clauses).length,
      "clauses across every policy",
    ).toBeGreaterThan(4);

    for (const merchant of policies) {
      for (const clause of merchant.clauses) {
        expect(clause.source.trim().length, `${clause.id} source`).toBeGreaterThan(0);
        expect(clause.quote.trim().length, `${clause.id} quote`).toBeGreaterThan(0);
      }
    }
  });

  it("quotes a figure that matches the remedy it encodes", () => {
    const clause = policy("Northwind Parcel").clauses.find(
      (c) => c.id === "northwind/delivery-guarantee#4.2",
    );

    expect(clause?.quote).toContain("$12");
    expect(clause?.quote).toContain("$15");
  });

  it("rejects a malformed policy rather than partially trusting it", () => {
    expect(() => parsePolicies([{ merchant: "Nobody", currency: "USD", clauses: [] }])).toThrow(
      PolicyParseError,
    );
  });

  it("rejects a clause with a blank source", () => {
    const clause = structuredClone(policy("Meridian Rides"));
    (clause.clauses[0] as { source: string }).source = "   ";

    expect(() => parsePolicies([clause])).toThrow(PolicyParseError);
  });
});

describe("remedyFor", () => {
  it("resolves the storyboard's phantom delivery to twelve, capped at fifteen", () => {
    const remedy = remedyFor(policy("Northwind Parcel"), "phantom_delivery");

    expect(remedy?.reservation).toEqual(usd(12));
    expect(remedy?.ceiling).toEqual(usd(15));
    expect(remedy?.clause.title).toBe("Delivery Guarantee 4.2");
  });

  it("resolves a missed window to eight, capped at ten", () => {
    const remedy = remedyFor(policy("Northwind Parcel"), "missed_window");

    expect(remedy?.reservation).toEqual(usd(8));
    expect(remedy?.ceiling).toEqual(usd(10));
  });

  it("gives back exactly what a price drop lost", () => {
    const remedy = remedyFor(policy("Calder & Co."), "price_drop", { shortfall: usd(15) });

    expect(remedy?.reservation).toEqual(usd(15));
    expect(remedy?.ceiling).toEqual(usd(15));
  });

  it("caps a price drop at the merchant's stated limit", () => {
    const remedy = remedyFor(policy("Calder & Co."), "price_drop", { shortfall: usd(400) });

    expect(remedy?.reservation).toEqual(usd(50));
  });

  it("returns nothing when the merchant published nothing covering the breach", () => {
    expect(remedyFor(policy("Meridian Rides"), "price_drop")).toBeUndefined();
  });

  it("returns nothing for a difference remedy with no shortfall to work from", () => {
    expect(remedyFor(policy("Calder & Co."), "price_drop")).toBeUndefined();
  });

  /**
   * The negotiator opens at the ceiling, so a ceiling below the stated figure would let
   * it ask for less than the merchant promised — the wrong failure to have.
   */
  it("never resolves a ceiling below the stated remedy", () => {
    let resolved = 0;
    fc.assert(
      fc.property(
        fc.constantFrom(...library.all()),
        fc.constantFrom(
          "late_eta" as const,
          "missed_window" as const,
          "phantom_delivery" as const,
          "no_show" as const,
          "late_refund" as const,
          "price_drop" as const,
        ),
        fc.integer({ min: 0, max: 100_000 }),
        (merchant, breachKind, minor) => {
          const remedy = remedyFor(merchant, breachKind, {
            amount_at_stake: { minor, currency: "USD" },
            shortfall: { minor, currency: "USD" },
          });
          if (remedy === undefined) return true;
          resolved += 1;
          return remedy.ceiling.minor >= remedy.reservation.minor;
        },
      ),
      { numRuns: 400 },
    );

    // Most of the grid is inapplicable by design — four merchants x six breach kinds, and
    // no merchant publishes a clause for every kind — so three runs in four take the early
    // return. 82 to 116 of 400 reached the invariant over five measurements; 40 is the
    // floor. Without this the property would still pass if `remedyFor` started returning
    // `undefined` for everything, which is the one regression it exists to notice.
    expect(resolved, "pairs that resolved to a remedy").toBeGreaterThan(40);
  });
});
