import { type EvidenceView, EvidenceViewSchema } from "@owed/domain";
import { createRoot } from "react-dom/client";
import "../shared/tokens.css";
import "./evidence.css";
import { useOwedView } from "../shared/useOwedView.js";
import { EvidenceCard } from "./EvidenceCard.js";

function App() {
  const { data, status } = useOwedView<EvidenceView>({
    name: "Owed Evidence",
    parse: (value) => EvidenceViewSchema.safeParse(value),
  });

  if (data) return <EvidenceCard evidence={data} />;
  return <p className="evidence__status">{status}</p>;
}

const container = document.getElementById("root");
if (container) createRoot(container).render(<App />);
