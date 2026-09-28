import { describe, expect, it } from "vitest";
import {
  addMoney,
  compareMoney,
  formatMoney,
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
