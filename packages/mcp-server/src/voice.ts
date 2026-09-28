import {
  coveragePercent,
  isZeroMoney,
  type LedgerSummaryView,
  numberToWords,
  speakMoney,
} from "@owed/domain";

/**
 * Alexa+ requires every critical feature to be completable by voice alone, and the
 * bridge requires exactly one content block per result. So each tool returns a single
 * self-sufficient spoken sentence — never a caption for a card the listener cannot see.
 */
export const MAX_SPOKEN_CHARS = 240;

const FORBIDDEN = [
  { pattern: /[*_#`|]/, why: "markdown markup" },
  { pattern: /https?:\/\//i, why: "a URL" },
  { pattern: /[0-9]/, why: "digits — numbers must be written the way they are said" },
  { pattern: /\s{2,}/, why: "repeated whitespace" },
];

export class UnspeakableTextError extends Error {}

/**
 * Reject anything that would read badly aloud.
 *
 * This runs on every tool result rather than only in tests, because a card that
 * looks right while the spoken line is broken is exactly the failure a screen-first
 * demo hides until the voice-only device is on stage.
 */
export function assertSpeakable(text: string): string {
  if (text.length === 0) throw new UnspeakableTextError("spoken text is empty");
  if (text.length > MAX_SPOKEN_CHARS) {
    throw new UnspeakableTextError(
      `spoken text is ${text.length} characters, over the ${MAX_SPOKEN_CHARS} limit: ${text}`,
    );
  }
  for (const { pattern, why } of FORBIDDEN) {
    if (pattern.test(text)) {
      throw new UnspeakableTextError(`spoken text contains ${why}: ${text}`);
    }
  }
  return text;
}

function sentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

export function joinSpoken(parts: readonly string[]): string {
  return parts
    .filter((p) => p.length > 0)
    .map(sentence)
    .join(" ");
}

const PERIOD_SPOKEN: Readonly<Record<LedgerSummaryView["period"], string>> = {
  week: "this week",
  month: "this month",
};

export function speakLedgerSummary(view: LedgerSummaryView): string {
  const period = PERIOD_SPOKEN[view.period];

  const money = isZeroMoney(view.open)
    ? `You've recovered ${speakMoney(view.recovered)} ${period}, and nothing is still open`
    : `You've recovered ${speakMoney(view.recovered)} ${period}, and ${speakMoney(view.open)} is still open`;

  const kept =
    view.kept === 0
      ? ""
      : view.kept === 1
        ? "One promise was kept"
        : `${capitalize(numberToWords(view.kept))} promises were kept`;

  return assertSpeakable(joinSpoken([money, kept, speakDeclined(view)]));
}

/**
 * The trust beat: Owed says what it did not see rather than claiming anyway.
 * Quoting the actual coverage is what makes the restraint credible.
 */
function speakDeclined(view: LedgerSummaryView): string {
  if (view.declined === 0) return "";

  const coverages = view.items
    .filter((item) => item.status === "Suspected" && item.coverage !== undefined)
    .map((item) => item.coverage as number);
  const lowest = coverages.length > 0 ? Math.min(...coverages) : undefined;

  const reason =
    lowest === undefined
      ? "I didn't see enough of the window to be sure"
      : `I only watched ${numberToWords(coveragePercent(lowest))} percent of the window`;

  return view.declined === 1
    ? `There's one I'm not claiming, because ${reason}`
    : `There are ${numberToWords(view.declined)} I'm not claiming, because ${reason}`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
