import * as z from "zod/v4";

export const CurrencySchema = z
  .string()
  .regex(/^[A-Z]{3}$/, "currency must be a 3-letter ISO-4217 code");
export type Currency = z.infer<typeof CurrencySchema>;

/**
 * An amount of money as integer minor units (cents) plus an ISO-4217 currency.
 * Never a bare number and never a float — see docs/contract-v1.md §5.
 */
export const MoneySchema = z.object({
  minor: z.number().int(),
  currency: CurrencySchema,
});
export type Money = z.infer<typeof MoneySchema>;

export function money(minor: number, currency: Currency): Money {
  if (!Number.isInteger(minor)) {
    throw new TypeError(`money() requires integer minor units, got ${minor}`);
  }
  return { minor, currency };
}

/** Build USD from a major-unit amount, e.g. `usd(12.5)` -> 1250 cents. */
export function usd(major: number): Money {
  return money(Math.round(major * 100), "USD");
}

export function zeroMoney(currency: Currency): Money {
  return money(0, currency);
}

export function isZeroMoney(a: Money): boolean {
  return a.minor === 0;
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new TypeError(`currency mismatch: ${a.currency} vs ${b.currency}`);
  }
}

export function addMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.minor + b.minor, a.currency);
}

export function subtractMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.minor - b.minor, a.currency);
}

/** Multiply by a ratio, rounding half away from zero to whole minor units. */
export function scaleMoney(a: Money, factor: number): Money {
  const scaled = a.minor * factor;
  const rounded = Math.sign(scaled) * Math.round(Math.abs(scaled));
  return money(rounded, a.currency);
}

export function sumMoney(items: readonly Money[], currency: Currency): Money {
  return items.reduce((acc, item) => addMoney(acc, item), zeroMoney(currency));
}

/** Negative when a < b, zero when equal, positive when a > b. */
export function compareMoney(a: Money, b: Money): number {
  assertSameCurrency(a, b);
  return a.minor - b.minor;
}

export function minMoney(a: Money, b: Money): Money {
  return compareMoney(a, b) <= 0 ? a : b;
}

export function maxMoney(a: Money, b: Money): Money {
  return compareMoney(a, b) >= 0 ? a : b;
}

const CURRENCY_SYMBOL: Readonly<Record<string, string>> = {
  USD: "$",
  EUR: "€",
  GBP: "£",
  INR: "₹",
};

/** Display form for views, e.g. "$47.00". */
export function formatMoney(a: Money): string {
  const symbol = CURRENCY_SYMBOL[a.currency] ?? `${a.currency} `;
  const sign = a.minor < 0 ? "-" : "";
  const abs = Math.abs(a.minor);
  return `${sign}${symbol}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/**
 * The largest major unit the spoken channel can say, and the ceiling on money as a whole.
 *
 * `numberToWords` throws above this. It always has; what was missing is anything connecting
 * that limit to what the system will *accept*. `MoneySchema` takes any safe integer, so
 * `formatMoney` rendered `$90071992547409.91` happily while `speakMoney` raised a `RangeError`
 * for the same value — and `voice.ts` speaks the **summed** recovered total, out of an
 * append-only ledger. A merchant that settled an $8.00 claim for $1,000,000,000.00 was
 * accepted, recorded, and took `ledger_summary`'s spoken line down for good: the same shape as
 * the EUR settlement that once took two tools down permanently, through the same guard.
 *
 * So the limit is named once here and derived everywhere else. An amount Owed cannot say is an
 * amount Owed will not hold, and `isSpeakable` is how the boundaries ask.
 */
export const SPOKEN_MAJOR_CEILING = 1_000_000_000;

/** The same ceiling in minor units: the largest amount `speakMoney` can render. */
export const MAX_SPEAKABLE_MINOR = SPOKEN_MAJOR_CEILING * 100 - 1;

/**
 * Can `speakMoney` state this amount without throwing?
 *
 * Derived from the constant the thrower uses rather than comparing against a second literal,
 * so the two cannot drift apart. Sign-independent, because `speakMoney` renders "minus" and
 * `numberToWords` is handed the absolute value.
 */
export function isSpeakable(a: Money): boolean {
  return Number.isInteger(a.minor) && Math.abs(a.minor) <= MAX_SPEAKABLE_MINOR;
}

const ONES = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

/** Spell a non-negative integer below one billion. Used for spoken output. */
export function numberToWords(value: number): string {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`numberToWords expects a non-negative integer, got ${value}`);
  }
  if (value >= SPOKEN_MAJOR_CEILING)
    throw new RangeError("numberToWords supports values below one billion");
  if (value < 20) return ONES[value] as string;
  if (value < 100) {
    const tens = TENS[Math.floor(value / 10)] as string;
    const rest = value % 10;
    return rest === 0 ? tens : `${tens}-${ONES[rest] as string}`;
  }
  for (const [limit, label] of [
    [1_000_000, "million"],
    [1_000, "thousand"],
    [100, "hundred"],
  ] as const) {
    if (value >= limit) {
      const head = `${numberToWords(Math.floor(value / limit))} ${label}`;
      const rest = value % limit;
      return rest === 0 ? head : `${head} ${numberToWords(rest)}`;
    }
  }
  /* c8 ignore next */
  throw new RangeError(`unreachable for ${value}`);
}

const CURRENCY_WORDS: Readonly<Record<string, readonly [string, string]>> = {
  USD: ["dollar", "cent"],
  EUR: ["euro", "cent"],
  GBP: ["pound", "penny"],
  INR: ["rupee", "paisa"],
};

function plural(word: string, count: number): string {
  if (count === 1) return word;
  return word === "penny" ? "pennies" : `${word}s`;
}

/**
 * Spoken form for the voice channel, e.g. "forty-seven dollars",
 * "twelve dollars and fifty cents". Never contains digits or symbols.
 */
export function speakMoney(a: Money): string {
  const words = CURRENCY_WORDS[a.currency];
  const negative = a.minor < 0;
  const abs = Math.abs(a.minor);
  const major = Math.floor(abs / 100);
  const minor = abs % 100;
  if (!words) {
    const amount =
      minor === 0 ? numberToWords(major) : `${numberToWords(major)} point ${numberToWords(minor)}`;
    return `${negative ? "minus " : ""}${amount} ${a.currency}`;
  }
  const [majorWord, minorWord] = words;
  const parts: string[] = [];
  if (major !== 0 || minor === 0) parts.push(`${numberToWords(major)} ${plural(majorWord, major)}`);
  if (minor !== 0) parts.push(`${numberToWords(minor)} ${plural(minorWord, minor)}`);
  return `${negative ? "minus " : ""}${parts.join(" and ")}`;
}
