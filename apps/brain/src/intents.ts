/**
 * Deterministic utterance routing.
 *
 * An LLM would be the obvious choice here and is the wrong one for a demo: the
 * storyboard has to produce the same tool call every single time it is run. A model
 * can be swapped in behind this same interface once the numbers are recorded.
 */
export interface Intent {
  name: string;
  matches: RegExp;
  tool: string;
  args: Record<string, unknown>;
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
];

export function routeUtterance(utterance: string): Intent | undefined {
  // Most specific first: a month query is also an "owed" query.
  return [...INTENTS].reverse().find((intent) => intent.matches.test(utterance));
}
