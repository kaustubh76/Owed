import { coveragePercent, type EvidenceView } from "@owed/domain";

const VERDICT_LABEL: Readonly<Record<string, string>> = {
  Kept: "kept",
  Suspected: "not enough to claim",
  Breached: "broken",
  Undetermined: "still watching",
};

const KIND_LABEL: Readonly<Record<string, string>> = {
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
  const percent = evidence.coverage === undefined ? undefined : coveragePercent(evidence.coverage);
  const window = evidence.evaluation_interval;
  const total = window ? minutes(window.start, window.end) : 0;

  return (
    <main className="evidence">
      <header className="evidence__headline">
        <span className="evidence__merchant">{evidence.merchant}</span>
        <span
          className={`evidence__verdict evidence__verdict--${(evidence.verdict ?? "Undetermined").toLowerCase()}`}
        >
          {VERDICT_LABEL[evidence.verdict ?? "Undetermined"]}
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

      {evidence.explanation ? <p className="evidence__why">{evidence.explanation}</p> : null}

      {evidence.gaps.length > 0 ? (
        <p className="evidence__gaps">
          Not watched:{" "}
          {evidence.gaps.map((gap) => `${clock(gap.start)}–${clock(gap.end)}`).join(", ")}
        </p>
      ) : null}

      <ul className="evidence__items">
        {evidence.items.slice(0, 3).map((item) => (
          <li className="evidence__item" key={item.evidence_id}>
            <span className="evidence__item-kind">{KIND_LABEL[item.kind] ?? item.kind}</span>
            <span className="evidence__item-detail">{item.detail ?? ""}</span>
            <span className="evidence__item-time">{clock(item.captured_at)}</span>
          </li>
        ))}
      </ul>
    </main>
  );
}
