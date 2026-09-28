import { formatMoney, type LedgerSummaryView } from "@owed/domain";
import { byAttention, KIND_LABEL, PERIOD_LABEL, STATUS_LABEL } from "./labels.js";

/** Alexa+ guidance is 3 to 5 items inline; three reads cleanly at 768x480. */
const MAX_ITEMS = 3;

export function LedgerCard({ summary }: { summary: LedgerSummaryView }) {
  const items = [...summary.items]
    .sort((a, b) => byAttention(a.status, b.status))
    .slice(0, MAX_ITEMS);

  return (
    <main className="ledger">
      <header className="ledger__headline">
        <span className="ledger__amount">{formatMoney(summary.recovered)}</span>
        <span className="ledger__caption">recovered {PERIOD_LABEL[summary.period]}</span>
      </header>

      <div className="ledger__stats">
        <div className="ledger__stat">
          <span className="ledger__stat-value ledger__stat-value--open">
            {formatMoney(summary.open)}
          </span>
          <span className="ledger__stat-label">still open</span>
        </div>
        <div className="ledger__stat">
          <span className="ledger__stat-value">{summary.kept}</span>
          <span className="ledger__stat-label">promises kept</span>
        </div>
      </div>

      <ul className="ledger__list">
        {items.map((item) => (
          <li className="ledger__item" key={item.promise_id}>
            <div>
              <div className="ledger__item-merchant">{item.merchant}</div>
              <div className="ledger__item-detail">
                {KIND_LABEL[item.kind]} &middot; {STATUS_LABEL[item.status]}
              </div>
            </div>
            {item.amount ? (
              <span className="ledger__item-amount">{formatMoney(item.amount)}</span>
            ) : null}
          </li>
        ))}
      </ul>

      {summary.declined > 0 ? (
        <p className="ledger__note">
          {summary.declined === 1
            ? "There is one promise I am not claiming — I did not watch enough of the window to be sure."
            : `There are ${summary.declined} promises I am not claiming — I did not watch enough of those windows to be sure.`}
        </p>
      ) : null}
    </main>
  );
}
