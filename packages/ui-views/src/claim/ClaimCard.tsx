import { type ClaimView, formatMoney } from "@owed/domain";

const STATE_LABEL: Readonly<Record<ClaimView["state"], string>> = {
  Proposed: "ready to file",
  Filed: "filed",
  Negotiating: "being argued",
  Settled: "settled",
  Escalated: "escalated",
  Recovered: "paid",
  WrittenOff: "written off",
};

const STEP_LABEL: Readonly<Record<string, string>> = {
  CLAIM: "Asked",
  OFFER: "They offered",
  COUNTER: "Countered",
  SETTLE: "Settled",
  DECLINE: "Declined",
};

/**
 * What went with the claim, in words.
 *
 * Read off the transcript rather than recomputed, because what matters is what the
 * merchant was actually sent — not what Owed could have said.
 */
function argumentMade(claim: ClaimView): string | undefined {
  const justification = claim.rounds.find(
    (round) => round.justification?.coverage_statement !== undefined,
  )?.justification;
  if (justification === undefined) return undefined;

  const attached = justification.evidence_ids.length;
  const count =
    attached === 0
      ? "No evidence was attached."
      : attached === 1
        ? "One piece of evidence went with it."
        : `${attached} pieces of evidence went with it.`;

  return `${justification.coverage_statement} ${count}`;
}

/**
 * The claim, as an exchange rather than a status.
 *
 * The transcript is the point: a household can see what was asked, what was offered and
 * which of the merchant's own clauses was used to close the gap.
 */
export function ClaimCard({ claim }: { claim: ClaimView }) {
  const headline = claim.recovered_amount ?? claim.settled_amount ?? claim.expected;
  const settled = claim.state === "Settled" || claim.state === "Recovered";
  const evidence = argumentMade(claim);

  return (
    <main className="claim">
      <header className="claim__headline">
        <span className={`claim__amount ${settled ? "claim__amount--settled" : ""}`}>
          {formatMoney(headline)}
        </span>
        <span className="claim__caption">
          {claim.merchant} &middot; {STATE_LABEL[claim.state]}
          {claim.round_count > 0
            ? ` in ${claim.round_count} ${claim.round_count === 1 ? "round" : "rounds"}`
            : ""}
        </span>
      </header>

      <ol className="claim__steps">
        {claim.rounds.map((round) => (
          <li className={`claim__step claim__step--${round.type.toLowerCase()}`} key={round.seq}>
            <span className="claim__step-label">{STEP_LABEL[round.type] ?? round.type}</span>
            <span className="claim__step-amount">
              {round.amount ? formatMoney(round.amount) : round.reason ? round.reason : ""}
            </span>
            {round.justification ? (
              <span className="claim__step-clause">{round.justification.policy_clause}</span>
            ) : null}
          </li>
        ))}
      </ol>

      {/*
        What Owed actually put to them.

        The steps show the shape of the argument; this is its substance — how much of the
        window was watched, and how many pieces of evidence went with the claim. A
        merchant's agent received exactly these words, and a household should be able to
        read what was said on their behalf.
      */}
      {evidence ? (
        <p className="claim__evidence">
          <span className="claim__evidence-label">Sent with the claim</span>
          {evidence}
        </p>
      ) : null}

      {claim.state === "Escalated" ? (
        <p className="claim__note">
          They declined, so this is with a person now. {formatMoney(claim.expected)} is still open.
        </p>
      ) : null}
      {claim.state === "Proposed" ? (
        <p className="claim__note">
          Their own policy says {formatMoney(claim.expected)}. Say the word and I&rsquo;ll file it.
        </p>
      ) : null}
    </main>
  );
}
