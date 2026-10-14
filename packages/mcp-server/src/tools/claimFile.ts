import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { inputRequired, inputResponse, type McpServer } from "@modelcontextprotocol/server";
import {
  fileClaim,
  fileWithoutAgent,
  merchantPriors,
  priorKey,
  type RemedyBounds,
  remedyContextFor,
} from "@owed/core";
import {
  type ClaimRoute,
  type ClaimView,
  ClaimViewSchema,
  coveragePercent,
  formatMoney,
  isActionable,
  numberToWords,
} from "@owed/domain";
import { builtinPolicies, remedyFor } from "@owed/policy-library";
import * as z from "zod/v4";
import type { OwedDeps } from "../deps.js";
import type { ProtocolEra } from "../server.js";
import { VIEW_URIS } from "../views.js";
import { assertSpeakable, joinSpoken, speakClaim } from "../voice.js";
import { loadContext, NotFoundError, spokenError } from "./context.js";
import { claimViewFor, findClaimForPromise } from "./projections.js";

/**
 * Which of the two agentless routes a merchant's own policy implies.
 *
 * Its own function because the seeded week has exactly one filable promise and it belongs
 * to the merchant that publishes a contact — so the `manual` arm is not reachable through
 * the tool without inventing a merchant, and a branch that cannot be reached by a test is
 * a branch nobody has checked.
 */
export function routeWithoutAgent(
  policy: { claims_contact?: string | undefined } | undefined,
): Exclude<ClaimRoute, "agent"> {
  return policy?.claims_contact === undefined ? "manual" : "email";
}

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
  //
  // `findClaimForPromise` does the promise-then-claim hop in one place; this spelled it
  // out, which is how the named version ended up with no caller.
  const existing = findClaimForPromise(context.state, promiseId);
  if (existing !== undefined) {
    return { kind: "result", result: claimResult(claimViewFor(existing)) };
  }

  const assessment = view.assessment;

  /**
   * The restraint that the whole product rests on. A promise Owed could not see enough
   * of is never filed, and the refusal says how little was seen rather than going quiet.
   */
  if (assessment === undefined || !isActionable(assessment)) {
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

  /**
   * No agent answered — so the claim is recorded anyway, and the household is told how
   * they will have to pursue it.
   *
   * This used to return an error saying "I'll keep the claim open", and keep nothing: no
   * events, no claim, nothing in the ledger. The household was told their claim had been
   * recorded when it had not, and asking again filed it from scratch. It is also where
   * `ClaimRoute`'s `email` and `manual` members belong; only `agent` had ever been
   * written, because `fileClaim` requires a `Respondent` and this branch never reached it.
   *
   * Which of the two depends on the merchant's own published policy: with a
   * `claims_contact` there is somewhere to send it, and without one all Owed can honestly
   * do is record what is owed under the clause it found.
   */
  if (respondent === undefined) {
    const route = routeWithoutAgent(policy);
    const events = fileWithoutAgent({
      householdId: deps.householdId,
      claimId: proposed.claim_id,
      promise: view.promise,
      bounds,
      route,
      proposedAt: context.now,
      filedAt: context.now,
      confirmedBy: "household",
      idGen: deps.idGen,
      ...(attachEvidence ? { attachedEvidenceIds: assessment.evidence_ids } : {}),
    });
    await deps.store.append(events);

    const after = await loadContext(deps);
    const filedWithoutAgent = after.state.claims.get(proposed.claim_id);
    return {
      kind: "result",
      result: claimResult(
        filedWithoutAgent === undefined ? proposed : claimViewFor(filedWithoutAgent),
        assertSpeakable(
          route === "email"
            ? `I can't reach ${view.promise.merchant}'s agent, so I've filed it against the address they publish for claims.`
            : `I can't reach ${view.promise.merchant}'s agent, so I've recorded what they owe you under their own policy, ready for you to send.`,
        ),
      ),
    };
  }

  /**
   * What the ledger already knows about arguing with this merchant about this.
   *
   * The projection, the structural type the negotiator accepts, and the comment saying
   * one satisfies the other all existed; nothing joined them, so every claim the shipped
   * add-on filed was a cold one no matter how much history the household had. This is the
   * join.
   *
   * It stays silent until `MIN_OBSERVATIONS` tries, because you cannot learn that a
   * merchant punishes negotiation without negotiating with them — so on the seeded week,
   * where no `(merchant, kind)` pair has more than two concluded claims, this changes
   * nothing. It starts mattering on the third encounter, which is the point.
   */
  const experience = merchantPriors(context.state).get(
    priorKey(view.promise.merchant, assessment.kind),
  );

  const filed = await fileClaim({
    householdId: deps.householdId,
    claimId: proposed.claim_id,
    promise: view.promise,
    detection: assessment,
    evidence: view.evidence,
    bounds,
    respondent,
    ...(experience === undefined ? {} : { experience }),
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

/**
 * `spoken` overrides the claim's own summary, for the one case where the card is right and
 * the sentence is not: a claim recorded with nobody to argue with has no rounds to read
 * out, and what the household needs to hear is what happens next.
 */
function claimResult(view: ClaimView, spoken?: string) {
  return {
    content: [{ type: "text" as const, text: spoken ?? speakClaim(view) }],
    structuredContent: view,
    _meta: { ui: { resourceUri: VIEW_URIS.claim }, "owed/data": view },
  };
}
