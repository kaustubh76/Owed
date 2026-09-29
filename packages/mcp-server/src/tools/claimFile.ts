import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { inputRequired, inputResponse, type McpServer } from "@modelcontextprotocol/server";
import { fileClaim, type RemedyBounds, remedyContextFor } from "@owed/core";
import {
  type ClaimView,
  ClaimViewSchema,
  coveragePercent,
  formatMoney,
  numberToWords,
} from "@owed/domain";
import { builtinPolicies, remedyFor } from "@owed/policy-library";
import * as z from "zod/v4";
import type { OwedDeps } from "../deps.js";
import type { ProtocolEra } from "../server.js";
import { VIEW_URIS } from "../views.js";
import { assertSpeakable, joinSpoken, speakClaim } from "../voice.js";
import { loadContext, NotFoundError, spokenError } from "./context.js";
import { claimViewFor } from "./projections.js";

/** Deterministic and readable, so the same promise always yields the same claim id. */
function claimIdFor(promiseId: string): string {
  return `clm_${promiseId}`;
}

/**
 * The confirmation Owed asks for before it files anything.
 *
 * Form mode, one flat object, primitive properties only — which is the whole of what MCP
 * elicitation permits. The ideation asks two questions ("file it?" and "attach the
 * doorbell evidence?"); they are asked together in one round rather than serially,
 * because a household being asked twice about one claim is worse, not better.
 *
 * Exported so the contract suite can assert the shape rather than trust it.
 */
export const CONFIRMATION_SCHEMA = {
  // Literal types where the wire shape demands them; `required` stays a mutable array.
  type: "object" as const,
  properties: {
    confirm: {
      type: "boolean" as const,
      title: "File this claim?",
      description: "Owed will send it to the merchant and settle it for you.",
    },
    attach_evidence: {
      type: "boolean" as const,
      title: "Send the supporting evidence?",
      description: "The merchant sees what was recorded, and nothing else.",
      default: true,
    },
  },
  required: ["confirm"],
};

/**
 * Whether this connection can carry a question back to the household.
 *
 * On the 2026-07-28 revision an input request is part of the result and the client
 * retries, so it works on stateless serving. On the 2025 revision it is a
 * server-to-client request needing a session, which per-request serving cannot make —
 * the SDK says so in as many words. There, and anywhere a client has not declared the
 * capability, the `confirm` argument carries it instead.
 *
 * See docs/friction-log.md: this is a real constraint of the SDK's recommended posture,
 * not a choice.
 */
function connectionCanAsk(server: McpServer, era: ProtocolEra): boolean {
  if (era === "modern") return true;
  const capabilities = (
    server as unknown as { server?: { getClientCapabilities?: () => unknown } }
  ).server?.getClientCapabilities?.();
  return typeof capabilities === "object" && capabilities !== null && "elicitation" in capabilities;
}

export function registerClaimFile(
  server: McpServer,
  deps: OwedDeps,
  era: ProtocolEra = "legacy",
): void {
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
    async ({ promise_id, confirm, attach_evidence }, ctx) => {
      /**
       * Re-entry after the household answered.
       *
       * Read as a discriminated view rather than through `acceptedContent`, which
       * returns `undefined` for a decline exactly as it does for "not asked yet" — so
       * asking again looked like the right thing and the exchange span until the
       * client's round cap. A decline has to be distinguishable from silence.
       */
      const answer = inputResponse(
        (ctx as { mcpReq?: { inputResponses?: unknown } }).mcpReq?.inputResponses as
          | Record<string, unknown>
          | undefined,
        "confirm",
      );
      const content = answer.kind === "elicit" ? (answer.content ?? {}) : undefined;

      const declined =
        answer.kind === "elicit" && (answer.action !== "accept" || content?.confirm !== true);
      const confirmed = confirm === true || content?.confirm === true;
      const attach =
        typeof content?.attach_evidence === "boolean"
          ? content.attach_evidence
          : attach_evidence !== false;

      try {
        if (declined) {
          return spokenError("All right, I won't file it.");
        }

        const outcome = await handleClaimFile(deps, promise_id, confirmed, attach);
        if (outcome.kind === "result") return outcome.result;

        if (connectionCanAsk(server, era)) {
          return inputRequired({
            inputRequests: {
              confirm: inputRequired.elicit({
                message: outcome.question,
                requestedSchema: CONFIRMATION_SCHEMA,
              }),
            },
          });
        }

        // No elicitation on this client: ask in words and wait to be called again.
        return outcome.fallback;
      } catch (error) {
        if (error instanceof NotFoundError) return spokenError("I don't have that promise.");
        throw error;
      }
    },
  );
}

type ClaimFileOutcome =
  | { kind: "result"; result: ReturnType<typeof claimResult> | ReturnType<typeof spokenError> }
  | { kind: "needs-confirmation"; question: string; fallback: ReturnType<typeof claimResult> };

async function handleClaimFile(
  deps: OwedDeps,
  promiseId: string,
  confirmed: boolean,
  attachEvidence: boolean,
): Promise<ClaimFileOutcome> {
  const context = await loadContext(deps);
  const view = context.state.promises.get(promiseId);
  if (view === undefined) throw new NotFoundError(promiseId);

  // Already filed: say where it got to rather than filing it twice.
  const existingId = view.claim_id;
  if (existingId !== undefined) {
    const existing = context.state.claims.get(existingId);
    if (existing !== undefined)
      return { kind: "result", result: claimResult(claimViewFor(existing)) };
  }

  const assessment = view.assessment;

  /**
   * The restraint that the whole product rests on. A promise Owed could not see enough
   * of is never filed, and the refusal says how little was seen rather than going quiet.
   */
  if (assessment === undefined || assessment.verdict !== "Breached") {
    return { kind: "result", result: spokenError(refusalFor(view.promise.merchant, assessment)) };
  }

  const policy = builtinPolicies().get(view.promise.merchant);
  const remedy =
    policy === undefined
      ? undefined
      : remedyFor(policy, assessment.kind, remedyContextFor(view.promise, view.evidence));

  // No published remedy means there is no claim to make. Owed does not invent one.
  if (remedy === undefined) {
    return {
      kind: "result",
      result: spokenError(
        assertSpeakable(
          `${view.promise.merchant} has published nothing covering this, so there is nothing for me to claim.`,
        ),
      ),
    };
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

  if (!confirmed) {
    return {
      kind: "needs-confirmation",
      question: `${view.promise.merchant} owes you ${formatMoney(bounds.reservation)} under their own policy. Shall I file it?`,
      fallback: claimResult(proposed),
    };
  }

  const respondent = deps.merchants.respondentFor(view.promise.merchant, {
    stated: bounds.reservation,
    clause_title: bounds.clause.title,
  });
  if (respondent === undefined) {
    return {
      kind: "result",
      result: spokenError(
        assertSpeakable(
          `I can't reach ${view.promise.merchant} right now. I'll keep the claim open.`,
        ),
      ),
    };
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
  return {
    kind: "result",
    result: claimResult(settled === undefined ? proposed : claimViewFor(settled)),
  };
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
