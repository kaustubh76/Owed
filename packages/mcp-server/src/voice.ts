import {
  type ClaimView,
  coveragePercent,
  type EvidenceView,
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

  return assertSpeakable(joinSpoken([money, kept, speakDeclined(view), speakReadyToFile(view)]));
}

/**
 * The claim waiting on a yes.
 *
 * Said last, because it is the only part of the summary that asks for anything.
 */
function speakReadyToFile(view: LedgerSummaryView): string {
  const ready = view.items.filter((item) => item.status === "Breached").length;
  if (ready === 0) return "";
  return ready === 1
    ? "There's one more I can file"
    : `There are ${numberToWords(ready)} more I can file`;
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

const KIND_SPOKEN: Readonly<Record<string, string>> = {
  delivery_window: "delivery",
  eta: "arrival time",
  refund_sla: "refund",
  appointment_slot: "appointment",
  guarantee: "guarantee",
  price_match: "price match",
  warranty: "warranty",
};

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

export interface PromisesListFilter {
  status?: string | undefined;
  merchant?: string | undefined;
}

export function speakPromisesList(view: LedgerSummaryView, filter: PromisesListFilter): string {
  const count = view.items.length;
  if (count === 0) {
    return assertSpeakable(
      filter.merchant === undefined
        ? "I'm not watching anything that matches."
        : `I'm not watching anything from ${filter.merchant} that matches.`,
    );
  }

  const from = filter.merchant === undefined ? "" : ` from ${filter.merchant}`;
  const head = `I'm watching ${numberToWords(count)} ${plural(count, "promise", "promises")}${from}`;

  const ready = view.items.filter((item) => item.status === "Breached").length;
  const tail =
    ready === 0
      ? ""
      : ready === 1
        ? "One is ready to file"
        : `${capitalize(numberToWords(ready))} are ready to file`;

  return assertSpeakable(joinSpoken([head, tail]));
}

/**
 * What the engine concluded about one promise.
 *
 * The `Suspected` branch is the one that matters: it says what was *not* seen, out loud,
 * rather than quietly declining to act.
 */
export function speakPromiseCheck(view: EvidenceView): string {
  const subject = `the ${view.merchant} ${KIND_SPOKEN[view.kind] ?? "promise"}`;
  const watched =
    view.coverage === undefined
      ? ""
      : `I watched ${numberToWords(coveragePercent(view.coverage))} percent of the window`;

  if (view.verdict === "Suspected") {
    return assertSpeakable(
      joinSpoken([`I'm not claiming ${subject}`, watched, "That isn't enough to be sure"]),
    );
  }
  if (view.verdict === "Kept") {
    return assertSpeakable(joinSpoken([`They kept ${subject}`]));
  }
  if (view.verdict === "Breached") {
    return assertSpeakable(joinSpoken([`${capitalize(subject)} was broken`, watched]));
  }
  return assertSpeakable(joinSpoken([`I'm still watching ${subject}`]));
}

export function speakEvidence(view: EvidenceView): string {
  const count = view.items.length;
  if (count === 0) {
    return assertSpeakable(`I have nothing on file for the ${view.merchant} promise.`);
  }
  const kinds = new Set(view.items.map((item) => item.kind.replace(/_/g, " ")));
  return assertSpeakable(
    joinSpoken([
      `I have ${numberToWords(count)} ${plural(count, "piece", "pieces")} of evidence for ${view.merchant}`,
      `${capitalize([...kinds].join(", "))}`,
    ]),
  );
}

const CLAIM_STATE_SPOKEN: Readonly<Record<string, string>> = {
  Proposed: "waiting on your say-so",
  Filed: "filed",
  Negotiating: "still being argued",
  Settled: "settled",
  Escalated: "escalated",
  Recovered: "settled and paid",
  WrittenOff: "written off",
};

export function speakClaim(view: ClaimView): string {
  const rounds =
    view.round_count === 0
      ? ""
      : `in ${numberToWords(view.round_count)} ${plural(view.round_count, "round", "rounds")}`;

  if (view.state === "Recovered" && view.recovered_amount) {
    return assertSpeakable(
      joinSpoken([`${view.merchant} paid ${speakMoney(view.recovered_amount)} ${rounds}`.trim()]),
    );
  }
  if (view.state === "Settled" && view.settled_amount) {
    return assertSpeakable(
      joinSpoken([
        `${view.merchant} settled at ${speakMoney(view.settled_amount)} ${rounds}`.trim(),
        "I'll tell you when the credit lands",
      ]),
    );
  }
  if (view.state === "Escalated") {
    return assertSpeakable(
      joinSpoken([
        `${view.merchant} declined, so I've escalated it`,
        `${speakMoney(view.expected)} is still open`,
      ]),
    );
  }
  if (view.state === "Proposed") {
    return assertSpeakable(
      joinSpoken([
        `${view.merchant} owes you ${speakMoney(view.expected)} under their own policy`,
        "Shall I file it?",
      ]),
    );
  }
  return assertSpeakable(
    joinSpoken([
      `The ${view.merchant} claim is ${CLAIM_STATE_SPOKEN[view.state] ?? "open"}`,
      `${speakMoney(view.expected)} is at stake`,
    ]),
  );
}
