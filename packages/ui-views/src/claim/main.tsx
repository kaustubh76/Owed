import { type ClaimView, ClaimViewSchema } from "@owed/domain";
import { createRoot } from "react-dom/client";
import "../shared/tokens.css";
import "./claim.css";
import { useOwedView } from "../shared/useOwedView.js";
import { ClaimCard } from "./ClaimCard.js";

function App() {
  const { data, status } = useOwedView<ClaimView>({
    name: "Owed Claim",
    parse: (value) => ClaimViewSchema.safeParse(value),
  });

  if (data) return <ClaimCard claim={data} />;
  return <p className="claim__status">{status}</p>;
}

const container = document.getElementById("root");
if (container) createRoot(container).render(<App />);
