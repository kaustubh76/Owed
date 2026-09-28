import { type LedgerSummaryView, LedgerSummaryViewSchema } from "@owed/domain";
import { createRoot } from "react-dom/client";
import "../shared/tokens.css";
import "./ledger.css";
import { useOwedView } from "../shared/useOwedView.js";
import { LedgerCard } from "./LedgerCard.js";

function App() {
  const { data, status } = useOwedView<LedgerSummaryView>({
    name: "Owed Ledger",
    parse: (value) => LedgerSummaryViewSchema.safeParse(value),
  });

  if (data) return <LedgerCard summary={data} />;
  return <p className="ledger__status">{status}</p>;
}

const container = document.getElementById("root");
if (container) createRoot(container).render(<App />);
