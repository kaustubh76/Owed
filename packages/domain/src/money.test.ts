import { describe, expect, it } from "vitest";
import {
  addMoney,
  compareMoney,
  formatMoney,
  isSpeakable,
  MAX_SPEAKABLE_MINOR,
  maxMoney,
  minMoney,
  money,
  numberToWords,
  scaleMoney,
  speakMoney,
  sumMoney,
  usd,
  zeroMoney,
} from "./money.js";

describe("money construction", () => {
  it("stores dollars as integer minor units", () => {
    expect(usd(12.5)).toEqual({ minor: 1250, currency: "USD" });
  });

  it("rounds away float error rather than storing it", () => {
    expect(usd(0.1 + 0.2)).toEqual({ minor: 30, currency: "USD" });
  });

  it("refuses fractional minor units", () => {
    expect(() => money(10.5, "USD")).toThrow(TypeError);
  });

  it("refuses to mix currencies", () => {
    expect(() => addMoney(usd(1), money(100, "EUR"))).toThrow(/currency mismatch/);
  });
});

describe("money arithmetic", () => {
  it("sums the storyboard's recovered total", () => {
    const recovered = sumMoney([usd(3), usd(12), usd(9), usd(15), usd(8)], "USD");
    expect(recovered).toEqual(usd(47));
  });

  it("sums an empty list to zero", () => {
    expect(sumMoney([], "USD")).toEqual(zeroMoney("USD"));
  });

  it("rounds scaling to whole minor units", () => {
    expect(scaleMoney(usd(12), 1.205)).toEqual(usd(14.46));
  });

  it("orders amounts", () => {
    expect(compareMoney(usd(5), usd(12))).toBeLessThan(0);
    expect(compareMoney(usd(12), usd(12))).toBe(0);
  });
});

describe("formatMoney", () => {
  it("pads cents", () => {
    expect(formatMoney(usd(47))).toBe("$47.00");
    expect(formatMoney(usd(8.5))).toBe("$8.50");
    expect(formatMoney(usd(0.05))).toBe("$0.05");
  });

  it("puts the sign before the symbol", () => {
    expect(formatMoney(usd(-3))).toBe("-$3.00");
  });
});

describe("numberToWords", () => {
  it.each([
    [0, "zero"],
    [8, "eight"],
    [15, "fifteen"],
    [20, "twenty"],
    [47, "forty-seven"],
    [100, "one hundred"],
    [118, "one hundred eighteen"],
    [1340, "one thousand three hundred forty"],
  ])("spells %i", (value, expected) => {
    expect(numberToWords(value)).toBe(expected);
  });

  it("rejects negatives", () => {
    expect(() => numberToWords(-1)).toThrow(RangeError);
  });
});

describe("speakMoney", () => {
  it("speaks the storyboard's headline", () => {
    expect(speakMoney(usd(47))).toBe("forty-seven dollars");
  });

  it("speaks the settled amount", () => {
    expect(speakMoney(usd(12))).toBe("twelve dollars");
  });

  it("joins dollars and cents", () => {
    expect(speakMoney(usd(12.5))).toBe("twelve dollars and fifty cents");
  });

  it("speaks a cents-only amount without a dollar part", () => {
    expect(speakMoney(usd(0.05))).toBe("five cents");
  });

  it("keeps one dollar singular", () => {
    expect(speakMoney(usd(1))).toBe("one dollar");
  });

  it("speaks zero", () => {
    expect(speakMoney(usd(0))).toBe("zero dollars");
  });

  it("never emits digits or symbols — it is read aloud", () => {
    for (const amount of [usd(0), usd(1), usd(8.5), usd(47), usd(1340.25)]) {
      expect(speakMoney(amount)).not.toMatch(/[0-9$.,]/);
    }
  });
});

/**
 * The comparison pair the domain publishes and nothing inside Owed calls.
 *
 * `@owed/domain` is `private: true`, so unlike the policy library's helpers these are not
 * API surface for anyone outside — they are vocabulary, and they stay because the one
 * place that genuinely needs them cannot have them: `policy-library/src/resolve.ts`
 * clamps a remedy between a floor and a ceiling with local `lower`/`higher` functions,
 * and it is a published package that must not depend on a private one.
 *
 * So rather than force a call site where none belongs, these are guaranteed. An untested
 * helper is a promise nobody checked, and `assertSameCurrency` underneath them means they
 * are not as trivial as they look.
 */
/**
 * The ceiling, and the only property that matters about it.
 *
 * `numberToWords` has always thrown above a billion major units; what was missing was anything
 * tying that limit to what the system *accepts*. `MoneySchema` takes any safe integer, so
 * `formatMoney` rendered `$90071992547409.91` while `speakMoney` raised `RangeError` for the
 * same value — and `voice.ts` speaks the summed recovered total out of an append-only ledger.
 * A merchant settling an $8.00 claim for $1,000,000,000.00 was accepted, recorded, and broke
 * every spoken summary from that moment on.
 *
 * So the test is not "the constant is 1e9". It is that **`isSpeakable` predicts `speakMoney`
 * exactly**, which is the thing the boundaries rely on. Both derive from one constant, so
 * moving that constant moves them together; a second literal anywhere would show up here as a
 * disagreement rather than as a RangeError three reads later.
 */
describe("what Owed can say, and therefore hold", () => {
  const says = (minor: number): boolean => {
    try {
      speakMoney({ minor, currency: "USD" });
      return true;
    } catch {
      return false;
    }
  };

  const AROUND_THE_EDGE = [
    0,
    1,
    800,
    99_999_999_999,
    MAX_SPEAKABLE_MINOR,
    MAX_SPEAKABLE_MINOR + 1,
    100_000_000_000,
    Number.MAX_SAFE_INTEGER,
  ];

  it("agrees with speakMoney on every amount, in both signs", () => {
    for (const minor of AROUND_THE_EDGE) {
      for (const signed of [minor, -minor]) {
        expect(isSpeakable({ minor: signed, currency: "USD" }), `minor ${signed}`).toBe(
          says(signed),
        );
      }
    }
  });

  it("puts the edge exactly where speakMoney stops", () => {
    expect(says(MAX_SPEAKABLE_MINOR)).toBe(true);
    expect(says(MAX_SPEAKABLE_MINOR + 1)).toBe(false);
  });

  /** The card had no ceiling, which is why nothing noticed the voice channel had one. */
  it("renders on the card what it cannot say aloud", () => {
    const unspeakable = { minor: MAX_SPEAKABLE_MINOR + 1, currency: "USD" as const };

    expect(formatMoney(unspeakable)).toBe("$1000000000.00");
    expect(() => speakMoney(unspeakable)).toThrow(RangeError);
  });
});

describe("choosing between two amounts", () => {
  it("takes the smaller and the larger", () => {
    expect(minMoney(money(300, "USD"), money(800, "USD"))).toStrictEqual(money(300, "USD"));
    expect(maxMoney(money(300, "USD"), money(800, "USD"))).toStrictEqual(money(800, "USD"));
  });

  it("is stable when the two are equal, returning the first", () => {
    const a = money(500, "USD");
    const b = money(500, "USD");
    // `<=` and `>=` both pick `a`, which matters for a clamp: an equal floor and ceiling
    // must not flip the result depending on which comparison ran.
    expect(minMoney(a, b)).toBe(a);
    expect(maxMoney(a, b)).toBe(a);
  });

  it("refuses to compare different currencies rather than guessing a rate", () => {
    expect(() => minMoney(money(300, "USD"), money(300, "EUR"))).toThrow();
    expect(() => maxMoney(money(300, "USD"), money(300, "EUR"))).toThrow();
  });

  it("clamps the way a remedy is clamped, floor then ceiling", () => {
    const floor = money(500, "USD");
    const ceiling = money(1500, "USD");
    const clamp = (v: ReturnType<typeof money>) => minMoney(maxMoney(v, floor), ceiling);

    expect(clamp(money(200, "USD"))).toStrictEqual(floor);
    expect(clamp(money(900, "USD"))).toStrictEqual(money(900, "USD"));
    expect(clamp(money(9000, "USD"))).toStrictEqual(ceiling);
  });
});
