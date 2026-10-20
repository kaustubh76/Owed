import {
  coveragePercent,
  type EvidenceKind,
  type EvidenceView,
  evidenceStance,
} from "@owed/domain";
import { STANCE_LABEL, UNWATCHED_REASON } from "./labels.js";

/**
 * Keyed by the domain's own union rather than by `string`.
 *
 * As `Record<string, string>` a new evidence kind compiled fine and rendered `undefined` on
 * the card — which is the failure a label map exists to prevent. The verdict map that used to
 * sit beside this one is now `STANCE_LABEL` in `./labels.js`, keyed the same way and shared
 * with the spoken line; `voice.ts`'s two maps and `ClaimCard`'s were keyed by `string` until
 * this rule was followed through to them.
 */
const KIND_LABEL: Readonly<Record<EvidenceKind, string>> = {
  timestamp: "timestamp",
  carrier_scan: "carrier scan",
  doorbell_event: "doorbell",
  doorbell_snapshot: "snapshot",
  refund_observed: "credit seen",
  price_observed: "price seen",
};

function clock(instant: string): string {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/Los_Angeles",
  }).format(new Date(instant));
}

function minutes(start: string, end: string): number {
  return Math.round((Date.parse(end) - Date.parse(start)) / 60000);
}

/**
 * What was seen, and what was not.
 *
 * The gaps are drawn, not summarised. A household that is being told "I am not claiming
 * this" is owed the reason in a form it can check.
 */
export function EvidenceCard({ evidence }: { evidence: EvidenceView }) {
  const stance = evidenceStance(evidence);
  const percent = evidence.coverage === undefined ? undefined : coveragePercent(evidence.coverage);
  const window = evidence.evaluation_interval;
  const total = window ? minutes(window.start, window.end) : 0;

  return (
    <main className="evidence">
      <header className="evidence__headline">
        <span className="evidence__merchant">{evidence.merchant}</span>
        <span className={`evidence__verdict evidence__verdict--${stance.toLowerCase()}`}>
          {STANCE_LABEL[stance]}
        </span>
      </header>

      {percent !== undefined ? (
        <section className="evidence__coverage">
          {/*
            The bar is the whole window, coloured as watched, with the unwatched stretches
            cut out of it where they actually fell. Drawing a left-aligned fill instead
            would put the watched time in the wrong place and contradict the gaps.
          */}
          <div className="evidence__bar" aria-hidden="true">
            {window
              ? evidence.gaps.map((gap) => (
                  <div
                    className="evidence__bar-gap"
                    key={gap.start}
                    style={{
                      left: `${(minutes(window.start, gap.start) / total) * 100}%`,
                      width: `${(minutes(gap.start, gap.end) / total) * 100}%`,
                    }}
                  />
                ))
              : null}
          </div>
          <p className="evidence__coverage-label">
            Watched {percent}% of the window
            {window ? ` from ${clock(window.start)} to ${clock(window.end)}` : ""}
          </p>
        </section>
      ) : null}

      {/*
        The reason, where there is no coverage bar to show one.

        A household told "not watched" is owed the same thing a household told "not enough to
        claim" is owed: why. There is no interval to draw here — nothing was ever evaluated —
        so the card says what it would have needed instead.
      */}
      {stance === "Unwatched" ? <p className="evidence__unwatched">{UNWATCHED_REASON}</p> : null}

      {evidence.explanation ? <p className="evidence__why">{evidence.explanation}</p> : null}

      {/*
        The merchant's own sentence.

        Everything else on this card is Owed's reading of what happened. This is the one
        line that is not: it is what they wrote, quoted, so a household can check the
        promise rather than take it on trust.
      */}
      {evidence.promised_in ? (
        <blockquote className="evidence__quote">
          <span className="evidence__quote-label">They wrote</span>
          {`\u201c${evidence.promised_in}\u201d`}
        </blockquote>
      ) : null}

      {evidence.gaps.length > 0 ? (
        <p className="evidence__gaps">
          Not watched:{" "}
          {evidence.gaps.map((gap) => `${clock(gap.start)}–${clock(gap.end)}`).join(", ")}
        </p>
      ) : null}

      <ul className="evidence__items">
        {evidence.items.slice(0, 3).map((item) => (
          <li className="evidence__item" key={item.evidence_id}>
            <span className="evidence__item-kind">{KIND_LABEL[item.kind]}</span>
            <span className="evidence__item-detail">{item.detail ?? ""}</span>
            <span className="evidence__item-time">{clock(item.captured_at)}</span>
          </li>
        ))}
      </ul>
    </main>
  );
}
