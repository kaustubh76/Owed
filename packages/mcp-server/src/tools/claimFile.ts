import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { inputRequired, inputResponse, type McpServer } from "@modelcontextprotocol/server";
import {
  derivesFromSiblings,
  fileClaim,
  fileWithoutAgent,
  merchantPriors,
  type PromiseView,
  priorKey,
  type RemedyBounds,
  remedyContextFor,
  type SiblingVerdict,
  sourceVerdictFor,
  UnspeakableAmount,
} from "@owed/core";
import {
  addMs,
  CLAIM_WINDOW_DAYS,
  type ClaimRoute,
  type ClaimView,
  ClaimViewSchema,
  coveragePercent,
  DAY_MS,
  formatMoney,
  isActionable,
  MAX_CLAIMS_PER_MERCHANT,
  numberToWords,
  type PromiseStatus,
} from "@owed/domain";
import { builtinPolicies, remedyFor } from "@owed/policy-library";
import { ProtocolViolation } from "@owed/recourse-protocol";
import * as z from "zod/v4";
import type { OwedDeps } from "../deps.js";
import type { ProtocolEra } from "../server.js";
import { MODEL_ONLY, VIEW_URIS } from "../views.js";
import { assertSpeakable, joinSpoken, speakClaim } from "../voice.js";
import { loadContext, NotFoundError, spokenError, type ToolContext } from "./context.js";
import { claimsAgainstMerchantSince, claimViewFor, findClaimForPromise } from "./projections.js";

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
          visibility: [...MODEL_ONLY],
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

        const outcome = await fileOnce(deps, promise_id, confirmed, attach);
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

/**
 * The promise a claim is really about.
 *
 * Returns the asked-for promise unchanged unless it takes its verdict from a sibling, in
 * which case it returns that sibling. Falls back to the asked-for promise when there is no
 * sibling to point at — a lone guarantee has no verdict either, so the refusals downstream
 * are the right answer rather than a redirect to nothing.
 */
function retargetToSource(context: ToolContext, asked: PromiseView): PromiseView {
  if (!derivesFromSiblings(asked.promise)) return asked;

  const siblings: SiblingVerdict[] = [...context.state.promises.values()].flatMap((other) =>
    other.assessment === undefined || derivesFromSiblings(other.promise)
      ? []
      : [{ promise: other.promise, detection: other.assessment }],
  );

  const source = sourceVerdictFor(asked.promise, siblings);
  if (source === undefined) return asked;
  return context.state.promises.get(source.promise.id) ?? asked;
}

/**
 * One filing per promise at a time.
 *
 * `handleClaimFile` reads the ledger, checks whether this promise already has a claim,
 * negotiates with the merchant and only then appends — and the check and the write are
 * separated by the whole negotiation, up to three round trips to an agent across a network.
 * Two calls that arrive together both passed the check, so the promise was claimed twice:
 * `ClaimProposed`, `ClaimFiled` and `Settled` written twice for one claim id, and the
 * merchant asked twice in the same instant about the same promise. Two taps on the home's
 * "File it" chip reach that, as do two Echo devices and a brain retrying a call it believed
 * had timed out.
 *
 * The store cannot catch it: `#reserveSequenceBlock` hands concurrent appends **disjoint**
 * sequence numbers, so `attribute_not_exists(sk)` keeps the log append-only and says nothing
 * about logical uniqueness. Nor could the figures catch it — they stayed correct throughout,
 * because the claim id is derived from the promise and every projection is a map keyed by it
 * whose events *set* fields rather than accumulate. What was wrong was the ledger holding one
 * claim's whole life twice and the merchant hearing about it twice, which is the pile-on the
 * frequency cap exists to prevent and which it cannot see, since it counts distinct claims.
 *
 * Same shape as `ensure()` in `apps/brain/src/session.ts`: one shared in-flight attempt, so N
 * calls produce one. A joined caller gets the first call's outcome, which is the claim that
 * was filed — the same answer the sequential path already returns from its idempotency check.
 * Entered only for a **confirmed** call, because an unconfirmed one asks a question and does
 * no work, and handing a caller that said `confirm: true` somebody else's "shall I?" would be
 * a new bug. Cleared in `finally`, so a failed attempt is not cached and the next call retries.
 *
 * **Per process, which is the deployment that exists** — one `owed-server` unit per box. Two
 * instances behind a load balancer would still race, and the answer there is a conditional
 * write on the *deterministic claim id* rather than on the sequence number. The id scheme
 * already allows it; nothing here implements it.
 */
const inFlightFilings = new WeakMap<OwedDeps["store"], Map<string, Promise<ClaimFileOutcome>>>();

/**
 * `handleClaimFile`, but at most one at a time per household and promise.
 *
 * Keyed by the **store**, which took one wrong turn worth recording: the map started as a
 * closure variable in `registerClaimFile`, which does nothing at all, because `server.ts` says
 * "a fresh server per request; all shared state lives in `deps`" — and `app.ts` builds a new
 * `{ ...deps, householdId }` literal for every request, so neither the closure nor the `deps`
 * object identity survives from one call to the next. The store is the object that does survive,
 * and it is the thing being protected. A `WeakMap` so a torn-down server takes its entry with
 * it, which also keeps one test's harness out of another's.
 *
 * `attachEvidence` is deliberately not part of the key: the point is that one promise becomes
 * one claim, so a second caller asking for a different evidence attachment joins the filing
 * already under way rather than starting a second one.
 */
function fileOnce(
  deps: OwedDeps,
  promiseId: string,
  confirmed: boolean,
  attachEvidence: boolean,
): Promise<ClaimFileOutcome> {
  if (!confirmed) return handleClaimFile(deps, promiseId, confirmed, attachEvidence);

  const existing = inFlightFilings.get(deps.store);
  const inFlight = existing ?? new Map<string, Promise<ClaimFileOutcome>>();
  if (existing === undefined) inFlightFilings.set(deps.store, inFlight);

  const key = `${deps.householdId}\u0000${promiseId}`;
  const running = inFlight.get(key);
  if (running !== undefined) return running;

  const attempt = handleClaimFile(deps, promiseId, confirmed, attachEvidence).finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, attempt);
  return attempt;
}

async function handleClaimFile(
  deps: OwedDeps,
  promiseId: string,
  confirmed: boolean,
  attachEvidence: boolean,
): Promise<ClaimFileOutcome> {
  const context = await loadContext(deps);
  const asked = context.state.promises.get(promiseId);
  if (asked === undefined) throw new NotFoundError(promiseId);

  /**
   * One failure, one claim — filed against the promise that actually failed.
   *
   * A `guarantee` or `warranty` has no evidence of its own: `derivedBreach` gives it the
   * verdict of a promise from the same merchant message, because "delivered between one and
   * five, guaranteed or your money back" is one sentence describing one way to fail. So a
   * claim about it is a claim about that promise, and the subject is swapped here — before
   * the idempotency check, the frequency cap and the remedy lookup, all of which then see
   * the real failure.
   *
   * **This replaced a one-directional dedup that order defeated.** The previous version only
   * recognised a derived promise when a claim already existed, so filing on the guarantee
   * first created a claim against the guarantee, and the window — not being derived — then
   * filed its own. Two claims for one failure, and `open` is summed over claims, so the
   * household was told it was owed twice what it was owed: $8 reported as $16, reachable by
   * asking about the guarantee and then saying "file it". Retargeting is order-independent,
   * and it makes the per-promise idempotency below do the deduplication by itself.
   *
   * `sourceVerdictFor` is the same selection `derivedBreach` makes when it inherits, so the
   * two cannot disagree about which promise a guarantee is about.
   */
  const view = retargetToSource(context, asked);
  const subjectId = view.promise.id;

  // Already filed: say where it got to rather than filing it twice.
  //
  // `findClaimForPromise` does the promise-then-claim hop in one place; this spelled it
  // out, which is how the named version ended up with no caller.
  const existing = findClaimForPromise(context.state, subjectId);
  if (existing !== undefined) {
    return { kind: "result", result: claimResult(claimViewFor(existing)) };
  }

  const assessment = view.assessment;

  /**
   * The restraint that the whole product rests on. A promise Owed could not see enough
   * of is never filed, and the refusal says how little was seen rather than going quiet.
   */
  if (assessment === undefined || !isActionable(assessment)) {
    return {
      kind: "result",
      result: spokenError(refusalFor(view.promise.merchant, view.status, assessment)),
    };
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

  /**
   * The per-merchant frequency cap — `product_ideation.md` §10's "to avoid vexatious
   * filing", which was listed as required and never built.
   *
   * Last of the refusals on purpose. A household that cannot see enough of a promise, or
   * whose merchant published nothing covering it, deserves to hear *that* rather than a
   * rate limit — so this only fires for a claim Owed was otherwise about to file, which is
   * the only case the merchant would experience as vexatious.
   *
   * Counted over the ledger rather than kept in memory, so it survives a restart and means
   * the same thing on every store adapter.
   */
  const since = addMs(context.now, -CLAIM_WINDOW_DAYS * DAY_MS);
  const recent = claimsAgainstMerchantSince(context.state, view.promise.merchant, since);
  if (recent >= MAX_CLAIMS_PER_MERCHANT) {
    return {
      kind: "result",
      result: spokenError(
        // Spelled out, because `assertSpeakable` forbids digits — `numberToWords` is
        // already how every other spoken figure in this file gets said.
        assertSpeakable(
          `I've already filed ${numberToWords(recent)} claims against ` +
            `${view.promise.merchant} this week, so I'll hold this one back rather than ` +
            "pile on. Ask me again in a few days.",
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
    claim_id: claimIdFor(subjectId),
    promise_id: subjectId,
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
  /**
   * Why the agent is not being used, which decides only the first clause of what is said.
   *
   * `unreachable` is the original case: nothing answered. `unusable` is a merchant that
   * answered and broke the protocol — a reply in another currency, a negative amount, a
   * different claim id. Both end the same way, because from the household's side they are
   * the same situation: this merchant's agent cannot settle the claim, and the claim must
   * still be recorded and still be pursuable by hand.
   */
  const recordWithoutAgent = async (why: "unreachable" | "unusable"): Promise<ClaimFileOutcome> => {
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
    const because =
      why === "unreachable"
        ? `I can't reach ${view.promise.merchant}'s agent`
        : `${view.promise.merchant}'s agent answered with something I couldn't use`;
    return {
      kind: "result",
      result: claimResult(
        filedWithoutAgent === undefined ? proposed : claimViewFor(filedWithoutAgent),
        assertSpeakable(
          route === "email"
            ? `${because}, so I've filed it against the address they publish for claims.`
            : `${because}, so I've recorded what they owe you under their own policy, ready for you to send.`,
        ),
      ),
    };
  };

  if (respondent === undefined) return recordWithoutAgent("unreachable");

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

  /**
   * A merchant that breaks the protocol must not take the claim down with it.
   *
   * `store.append` is below, after the whole negotiation, so until this `catch` existed a
   * violation on round two discarded round one's offer as well — no `ClaimProposed`, no
   * `ClaimFiled`, nothing in the ledger, and the household told by a raw exception message
   * that had never passed `assertSpeakable`. That is precisely the failure
   * `fileWithoutAgent` was written to fix for the unreachable case, reproduced for the
   * misbehaving one, and it is why the fix routes to the same place rather than inventing
   * a second kind of half-filed claim.
   */
  let filed: Awaited<ReturnType<typeof fileClaim>>;
  try {
    filed = await fileClaim({
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
  } catch (error) {
    // Two different rules, one answer: the agent said something Owed will not record, so
    // the claim goes on a route that does not need the agent. `UnspeakableAmount` is Owed's
    // own ceiling rather than the protocol's, raised by `filing.ts` before the append.
    if (error instanceof ProtocolViolation || error instanceof UnspeakableAmount) {
      return recordWithoutAgent("unusable");
    }
    throw error;
  }

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
  status: PromiseStatus,
  assessment: { verdict: string; coverage: number } | undefined,
): string {
  /**
   * A promise Owed is not sure anybody made.
   *
   * `Candidate` means the extractor read it below `TRACKING_CONFIDENCE` — recorded so the
   * household can see it and the sentence it came from, and not tracked. Saying "I haven't
   * finished looking at it yet" would be untrue: Owed has finished, and the answer is that
   * it is not confident this is a promise at all.
   */
  if (status === "Candidate") {
    return assertSpeakable(
      `I'm not tracking that one. I wasn't sure enough that ${merchant} actually promised it.`,
    );
  }
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
