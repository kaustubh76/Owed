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
  needsFocus?: "pending" | "declined";
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
  {
    name: "file_it",
    matches: /\b(file it|file that|file this|claim it|claim that|go ahead|yes,? file)\b/i,
    tool: "claim_file",
    args: { confirm: true },
    needsFocus: "pending",
  },
];

/** Most specific first: "file it" and "why" beat the general ledger query. */
export function routeUtterance(utterance: string): Intent | undefined {
  return [...INTENTS].reverse().find((intent) => intent.matches.test(utterance));
}
