import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { builtinPolicies, PolicyParseError, parsePolicies } from "./load.js";
import { remedyFor } from "./resolve.js";
import type { MerchantPolicy, Money } from "./schema.js";

const usd = (major: number): Money => ({ minor: Math.round(major * 100), currency: "USD" });
const library = builtinPolicies();
const policy = (merchant: string): MerchantPolicy => {
  const found = library.get(merchant);
  if (!found) throw new Error(`no policy for ${merchant}`);
  return found;
};

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
    for (const merchant of library.all()) {
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
          return remedy.ceiling.minor >= remedy.reservation.minor;
        },
      ),
      { numRuns: 400 },
    );
  });
});
