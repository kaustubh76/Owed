/**
 * Deterministic utterance routing.
 *
 * An LLM would be the obvious choice and is the wrong one for a demo: the storyboard has
 * to produce the same tool call every single run. A model can be swapped in behind this
 * same interface once the numbers are recorded.
 */
export interface Intent {
  name: string;
  matches: RegExp;
  tool: string;
  args: Record<string, unknown>;
  /**
   * Needs to know which promise is being talked about.
   *
   * "File it" only means anything after something has been mentioned, so the brain
   * supplies the promise it last put in front of the household.
   */
  needsFocus?: "pending" | "declined" | "unwatched";
  /**
   * An utterance this intent must refuse even when `matches` fires.
   *
   * Exists for exactly one intent, and for a reason worth stating. `file_it` matches
   * `claim it`, which is a substring of **"do not claim it"** and of **"why won't you claim
   * it?"** — so a household refusing, or asking a question, had a claim filed against a
   * merchant with `confirm: true`, the flag that represents their explicit consent. The
   * product's stated position is that nothing files without the household's yes; a negation
   * was supplying that yes.
   */
  notWhen?: RegExp;
}

export const INTENTS: readonly Intent[] = [
  {
    name: "what_am_i_owed",
    matches: /\b(what (am i|do i get|are we) owed|what.*\bowe(d)?\b|my ledger|recovered)\b/i,
    tool: "ledger_summary",
    args: {},
  },
  {
    name: "what_came_back_this_month",
    matches: /\b(this|last) month\b/i,
    tool: "ledger_summary",
    args: { period: "month" },
  },
  {
    name: "list_promises",
    matches: /\b(what are you watching|watching|my promises|list)\b/i,
    tool: "promises_list",
    args: {},
  },
  {
    name: "why",
    matches: /\b(why|what did you see|how much did you watch|explain)\b/i,
    tool: "promise_check",
    args: {},
    needsFocus: "pending",
  },
  {
    name: "why_not_claiming",
    matches: /(aren'?t you claiming|not claiming|won'?t you claim|why not claim)/i,
    tool: "promise_check",
    args: {},
    needsFocus: "declined",
  },
  /**
   * The third refusal, and the one with no way to ask about it until now.
   *
   * "Not claiming" and "not watching" are different answers — the first means Owed looked
   * and saw too little, the second means there is nothing it could look at. Matched
   * separately from `why_not_claiming` so the household gets the one it asked for.
   */
  {
    name: "why_not_watching",
    matches: /(aren'?t you watching|not watching|won'?t you watch|why not watch)/i,
    tool: "promise_check",
    args: {},
    needsFocus: "unwatched",
  },
  {
    name: "file_it",
    matches: /\b(file it|file that|file this|claim it|claim that|go ahead|yes,? file)\b/i,
    /**
     * A question is never an instruction, and a refusal is the opposite of one.
     *
     * Biased towards not filing on purpose. Refusing an ambiguous utterance costs the
     * household one more sentence; filing on an ambiguous one costs them a claim against a
     * merchant they did not authorise, and `claim_file` is the only irreversible,
     * outward-facing thing Owed does. "No, file it" is caught by this too, which is the
     * trade accepted rather than overlooked.
     */
    notWhen: /\b(why|how|should|whether|not|never|no)\b|n['\u2019]t\b/i,
    tool: "claim_file",
    args: { confirm: true },
    needsFocus: "pending",
  },
];

/**
 * Most specific first: "file it" and "why" beat the general ledger query.
 *
 * Searched in reverse, so the last entry wins — which makes the table order load-bearing and
 * is why `intents.test.ts` asserts every intent is still reachable. An intent that declares
 * `notWhen` is skipped when it fires, and the search continues past it rather than stopping:
 * "why won't you claim it?" should be answered, not dropped, and the intent that answers it
 * sits earlier in the table.
 */
export function routeUtterance(utterance: string): Intent | undefined {
  return [...INTENTS]
    .reverse()
    .find(
      (intent) => intent.matches.test(utterance) && !(intent.notWhen?.test(utterance) ?? false),
    );
}
