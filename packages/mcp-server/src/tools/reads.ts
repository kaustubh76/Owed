import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/server";
import { ClaimViewSchema, EvidenceViewSchema } from "@owed/domain";
import * as z from "zod/v4";
import type { OwedDeps } from "../deps.js";
import { VIEW_URIS } from "../views.js";
import { speakClaim, speakEvidence, speakPromiseCheck } from "../voice.js";
import { loadContext, NotFoundError, requireClaim, spokenError } from "./context.js";
import { claimViewFor, evidenceViewFor } from "./projections.js";

/** Read-only tools. Each answers for the instant on the clock, so the scrubber moves them all. */
export function registerReadTools(server: McpServer, deps: OwedDeps): void {
  registerAppTool(
    server,
    "promise_check",
    {
      title: "Check a promise",
      description:
        "Explain what Owed concluded about one promise and why — the coverage, the evidence, and the stretches nobody was watching. Answers 'why?' and 'why aren't you claiming that?'",
      inputSchema: z.object({ promise_id: z.string().min(1) }),
      outputSchema: EvidenceViewSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
      _meta: {
        ui: {
          resourceUri: VIEW_URIS.evidence,
          invoking: "Looking at what I saw",
          invoked: "Here is what I saw",
        },
      },
    },
    async ({ promise_id }) => {
      try {
        const view = evidenceViewFor(await loadContext(deps), promise_id);
        return {
          content: [{ type: "text", text: speakPromiseCheck(view) }],
          structuredContent: view,
          _meta: { ui: { resourceUri: VIEW_URIS.evidence }, "owed/data": view },
        };
      } catch (error) {
        if (error instanceof NotFoundError) return spokenError("I don't have that promise.");
        throw error;
      }
    },
  );

  registerAppTool(
    server,
    "evidence_get",
    {
      title: "Get one piece of evidence",
      description: "Retrieve a single piece of evidence and the promise it belongs to.",
      inputSchema: z.object({ evidence_id: z.string().min(1), promise_id: z.string().min(1) }),
      outputSchema: EvidenceViewSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
      _meta: {
        ui: {
          resourceUri: VIEW_URIS.evidence,
          invoking: "Fetching that evidence",
          invoked: "Here it is",
        },
      },
    },
    async ({ evidence_id, promise_id }) => {
      try {
        const view = evidenceViewFor(await loadContext(deps), promise_id, evidence_id);
        return {
          content: [{ type: "text", text: speakEvidence(view) }],
          structuredContent: view,
          _meta: { ui: { resourceUri: VIEW_URIS.evidence }, "owed/data": view },
        };
      } catch (error) {
        if (error instanceof NotFoundError) return spokenError("I don't have that evidence.");
        throw error;
      }
    },
  );

  registerAppTool(
    server,
    "claim_status",
    {
      title: "Check a claim",
      description:
        "Show where a claim has got to — what was asked, what was offered, what was countered and what was settled. Answers 'what happened with that claim?'",
      inputSchema: z.object({ claim_id: z.string().min(1) }),
      outputSchema: ClaimViewSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
      _meta: {
        ui: {
          resourceUri: VIEW_URIS.claim,
          invoking: "Checking that claim",
          invoked: "Here is where it got to",
        },
      },
    },
    async ({ claim_id }) => {
      try {
        const view = claimViewFor(requireClaim(await loadContext(deps), claim_id));
        return {
          content: [{ type: "text", text: speakClaim(view) }],
          structuredContent: view,
          _meta: { ui: { resourceUri: VIEW_URIS.claim }, "owed/data": view },
        };
      } catch (error) {
        if (error instanceof NotFoundError) return spokenError("I don't have that claim.");
        throw error;
      }
    },
  );
}
