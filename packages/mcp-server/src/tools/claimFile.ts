import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/server";
import { fileClaim, type RemedyBounds, remedyContextFor } from "@owed/core";
import { type ClaimView, ClaimViewSchema, coveragePercent, numberToWords } from "@owed/domain";
import { builtinPolicies, remedyFor } from "@owed/policy-library";
import * as z from "zod/v4";
import type { OwedDeps } from "../deps.js";
import { VIEW_URIS } from "../views.js";
import { assertSpeakable, joinSpoken, speakClaim } from "../voice.js";
import { loadContext, NotFoundError, spokenError } from "./context.js";
import { claimViewFor } from "./projections.js";

/** Deterministic and readable, so the same promise always yields the same claim id. */
function claimIdFor(promiseId: string): string {
  return `clm_${promiseId}`;
}

export function registerClaimFile(server: McpServer, deps: OwedDeps): void {
  registerAppTool(
    server,
    "claim_file",
    {
      title: "File a claim",
      description:
        "File a claim for a broken promise and settle it with the merchant's agent. Answers 'file it', 'claim that' and 'go ahead'. Needs the household's confirmation first.",
      inputSchema: z.object({
        promise_id: z.string().min(1),
        confirm: z
          .boolean()
          .optional()
          .describe("The household's yes. Nothing is filed without it."),
        attach_evidence: z
          .boolean()
          .optional()
          .describe("Send the supporting evidence with the claim. Defaults to true."),
      }),
      outputSchema: ClaimViewSchema,
      annotations: { readOnlyHint: false, idempotentHint: true },
      _meta: {
        ui: {
          resourceUri: VIEW_URIS.claim,
          invoking: "Filing your claim",
          invoked: "Here is how it went",
        },
      },
    },
    async ({ promise_id, confirm, attach_evidence }) => {
      try {
        return await handleClaimFile(deps, promise_id, confirm === true, attach_evidence !== false);
      } catch (error) {
        if (error instanceof NotFoundError) return spokenError("I don't have that promise.");
        throw error;
      }
    },
  );
}

async function handleClaimFile(
  deps: OwedDeps,
  promiseId: string,
  confirmed: boolean,
  attachEvidence: boolean,
) {
  const context = await loadContext(deps);
  const view = context.state.promises.get(promiseId);
  if (view === undefined) throw new NotFoundError(promiseId);

  // Already filed: say where it got to rather than filing it twice.
  const existingId = view.claim_id;
  if (existingId !== undefined) {
    const existing = context.state.claims.get(existingId);
    if (existing !== undefined) return claimResult(claimViewFor(existing));
  }

  const assessment = view.assessment;

  /**
   * The restraint that the whole product rests on. A promise Owed could not see enough
   * of is never filed, and the refusal says how little was seen rather than going quiet.
   */
  if (assessment === undefined || assessment.verdict !== "Breached") {
    return spokenError(refusalFor(view.promise.merchant, assessment));
  }

  const policy = builtinPolicies().get(view.promise.merchant);
  const remedy =
    policy === undefined
      ? undefined
      : remedyFor(policy, assessment.kind, remedyContextFor(view.promise, view.evidence));

  // No published remedy means there is no claim to make. Owed does not invent one.
  if (remedy === undefined) {
    return spokenError(
      assertSpeakable(
        `${view.promise.merchant} has published nothing covering this, so there is nothing for me to claim.`,
      ),
    );
  }

  const bounds: RemedyBounds = {
    reservation: remedy.reservation,
    ceiling: remedy.ceiling,
    clause: { id: remedy.clause.id, title: remedy.clause.title },
  };

  const proposed: ClaimView = {
    claim_id: claimIdFor(promiseId),
    promise_id: promiseId,
    merchant: view.promise.merchant,
    state: "Proposed",
    ask: bounds.ceiling,
    expected: bounds.reservation,
    rounds: [],
    round_count: 0,
  };

  if (!confirmed) return claimResult(proposed);

  const respondent = deps.merchants.respondentFor(view.promise.merchant, {
    stated: bounds.reservation,
    clause_title: bounds.clause.title,
  });
  if (respondent === undefined) {
    return spokenError(
      assertSpeakable(
        `I can't reach ${view.promise.merchant} right now. I'll keep the claim open.`,
      ),
    );
  }

  const filed = await fileClaim({
    householdId: deps.householdId,
    claimId: proposed.claim_id,
    promise: view.promise,
    detection: assessment,
    evidence: view.evidence,
    bounds,
    respondent,
    proposedAt: context.now,
    filedAt: context.now,
    confirmedBy: "household",
    idGen: deps.idGen,
    // A live exchange happens now, not in the future. The seed spaces replies so a replay
    // can catch a negotiation mid-flight; here that spacing would push the whole
    // transcript past the clock and the claim would read as merely filed.
    replyIntervalMs: 0,
    ...(attachEvidence ? { attachedEvidenceIds: assessment.evidence_ids } : {}),
    coverageStatement: coverageStatement(assessment.coverage),
  });

  await deps.store.append(filed.events);

  const after = await loadContext(deps);
  const settled = after.state.claims.get(proposed.claim_id);
  return claimResult(settled === undefined ? proposed : claimViewFor(settled));
}

function coverageStatement(coverage: number): string {
  return `Coverage of the evaluated window was ${coveragePercent(coverage)}%.`;
}

function refusalFor(
  merchant: string,
  assessment: { verdict: string; coverage: number } | undefined,
): string {
  if (assessment === undefined) {
    return assertSpeakable(`I haven't finished looking at that ${merchant} promise yet.`);
  }
  if (assessment.verdict === "Kept") {
    return assertSpeakable(`${merchant} kept that one, so there's nothing to claim.`);
  }
  if (assessment.verdict === "Suspected") {
    return assertSpeakable(
      joinSpoken([
        `I won't file that one`,
        `I only watched ${numberToWords(coveragePercent(assessment.coverage))} percent of the window`,
        "That isn't enough to say it was broken",
      ]),
    );
  }
  return assertSpeakable(`I'm still watching that ${merchant} promise.`);
}

function claimResult(view: ClaimView) {
  return {
    content: [{ type: "text" as const, text: speakClaim(view) }],
    structuredContent: view,
    _meta: { ui: { resourceUri: VIEW_URIS.claim }, "owed/data": view },
  };
}
