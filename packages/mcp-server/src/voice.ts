import {
  type ClaimState,
  type ClaimView,
  coveragePercent,
  type EvidenceView,
  evidenceStance,
  isDerivedKind,
  isZeroMoney,
  type LedgerSummaryView,
  numberToWords,
  type PromiseKind,
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
/**
 * What Owed could actually file, if asked.
 *
 * Three conditions, and only the first was being checked. `Breached` is necessary; a promise
 * that **already has a claim** cannot be filed again — `claim_file` is idempotent and hands
 * back the existing one — and a derived kind is the same failure as its sibling, so offering
 * both is offering one thing twice.
 *
 * The missing claim check was the older bug of the two. It does not show in the recorded week,
 * where the one `Breached` promise is unclaimed, but any promise re-judged while a claim is
 * under way read as filable again: "there are two more I can file" with one of them already
 * being argued.
 */
function filable(view: LedgerSummaryView): number {
  return view.items.filter(
    (item) =>
      item.status === "Breached" && item.claim_id === undefined && !isDerivedKind(item.kind),
  ).length;
}

function speakReadyToFile(view: LedgerSummaryView): string {
  const ready = filable(view);
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

/**
 * Keyed by the union, like the cards' label maps and for the reason their header gives: as
 * `Record<string, string>` an added promise kind compiled fine and was spoken as the word
 * "promise" via a `??` fallback. The fallback was the problem — it guaranteed the code would
 * never complain. All seven are here, and an eighth will not compile until it is.
 */
const KIND_SPOKEN: Readonly<Record<PromiseKind, string>> = {
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
  /**
   * Only the ones it is actually watching.
   *
   * `items` includes a promise Owed cannot police — a warranty with `watched: false` — and
   * counting it here had the ledger say "I'm watching twelve promises" while `promise_check`
   * on one of them said "I'm not claiming to watch it". The same system, two answers.
   */
  const count = view.items.filter((item) => item.watched !== false).length;
  if (count === 0) {
    return assertSpeakable(
      filter.merchant === undefined
        ? "I'm not watching anything that matches."
        : `I'm not watching anything from ${filter.merchant} that matches.`,
    );
  }

  const from = filter.merchant === undefined ? "" : ` from ${filter.merchant}`;
  const head = `I'm watching ${numberToWords(count)} ${plural(count, "promise", "promises")}${from}`;

  const ready = filable(view);
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
  const subject = `the ${view.merchant} ${KIND_SPOKEN[view.kind]}`;
  const watched =
    view.coverage === undefined
      ? ""
      : `I watched ${numberToWords(coveragePercent(view.coverage))} percent of the window`;

  const stance = evidenceStance(view);

  if (stance === "Suspected") {
    return assertSpeakable(
      joinSpoken([`I'm not claiming ${subject}`, watched, "That isn't enough to be sure"]),
    );
  }
  if (stance === "Kept") {
    return assertSpeakable(joinSpoken([`They kept ${subject}`]));
  }
  if (stance === "Breached") {
    return assertSpeakable(joinSpoken([`${capitalize(subject)} was broken`, watched]));
  }
  /**
   * Nothing is coming, said plainly.
   *
   * This fell straight through to "I'm still watching", which was false for any promise no
   * detector covers — and `guarantee` and `warranty` had no detector at all, so Owed
   * announced it was watching two of its seven kinds for the life of the process. Both have
   * one now, and what is left is a promise read too weakly to judge: an `eta` with no
   * deadline has nothing to be late against.
   */
  if (stance === "Unwatched") {
    // One part, not two. `joinSpoken` ends every part with a full stop, so splitting this
    // produced "…whether they keep it. so I'm not claiming to watch it." — a lowercase
    // sentence of its own.
    return assertSpeakable(
      joinSpoken([
        `I've written ${subject} down, but nothing the home sees would tell me whether they keep it, so I'm not claiming to watch it`,
      ]),
    );
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

/** Keyed by the union for the same reason; `?? "open"` hid an unspoken state as "open". */
const CLAIM_STATE_SPOKEN: Readonly<Record<ClaimState, string>> = {
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
      `The ${view.merchant} claim is ${CLAIM_STATE_SPOKEN[view.state]}`,
      `${speakMoney(view.expected)} is at stake`,
    ]),
  );
}
