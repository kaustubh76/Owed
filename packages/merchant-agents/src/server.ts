import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { type BreachKind, builtinPolicies, remedyFor } from "@owed/policy-library";
import {
  type ClaimMessage,
  RecourseMessageSchema,
  RespondentMessageSchema,
} from "@owed/recourse-protocol";
import type { Express, Request, Response } from "express";
import * as z from "zod/v4";
import { createMerchantAgent, type StatedRemedy } from "./agent.js";
import type { MerchantConfig } from "./behaviour.js";
import { STORYBOARD_MERCHANTS } from "./presets.js";

/**
 * A reference merchant agent, served over MCP.
 *
 * The recourse protocol is MCP-shaped, and this is what that means in practice: a
 * merchant implements one tool and is reachable by any claimant that speaks the
 * specification. Clone it, point it at your own policies, and you have an agent.
 */

export function merchantSlug(merchant: string): string {
  return merchant
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * What this merchant's own published policy says it owes.
 *
 * The claimant does not get to tell a merchant what it owes — it asks, and the merchant
 * answers from its own terms. A price match is the one case needing a figure the claim
 * does not carry, and the claim's `ask` is that figure: the ask is the claimant's reading
 * of this merchant's ceiling, and for a difference remedy the ceiling is the shortfall.
 * This merchant's own ceiling still binds it.
 */
function ownRemedy(
  merchant: string,
  breachKind: BreachKind,
  claim: ClaimMessage,
): StatedRemedy | undefined {
  const policy = builtinPolicies().get(merchant);
  if (policy === undefined) return undefined;

  const remedy = remedyFor(policy, breachKind, {
    shortfall: claim.ask,
    ...(claim.promise.amount_at_stake === undefined
      ? {}
      : { amount_at_stake: claim.promise.amount_at_stake }),
  });
  if (remedy === undefined) return undefined;

  return { stated: remedy.reservation, clause_title: remedy.clause.title };
}

function describe(reply: { type: string; amount?: { minor: number; currency: string } }): string {
  const amount =
    reply.amount === undefined
      ? ""
      : ` ${(reply.amount.minor / 100).toFixed(2)} ${reply.amount.currency}`;
  return `${reply.type}${amount}`;
}

export function createMerchantMcpServer(config: MerchantConfig): McpServer {
  const server = new McpServer({ name: merchantSlug(config.merchant), version: "1.0.0" });

  server.registerTool(
    "recourse_respond",
    {
      title: `${config.merchant} recourse`,
      description:
        "Answer a recourse claim. Takes the transcript so far and returns this merchant's next message: an offer, a settlement, or a refusal with somewhere for the household to go.",
      inputSchema: z.object({ transcript: z.array(RecourseMessageSchema).min(1) }),
      outputSchema: RespondentMessageSchema,
    },
    async ({ transcript }) => {
      const claim = transcript[0];
      if (claim === undefined || claim.type !== "CLAIM") {
        return {
          content: [{ type: "text", text: "A transcript must open with a CLAIM." }],
          isError: true,
        };
      }

      const agent = createMerchantAgent({
        config,
        lookup: (breachKind, message) => ownRemedy(config.merchant, breachKind, message),
      });
      const reply = await agent.respond(transcript);

      return {
        content: [{ type: "text", text: describe(reply) }],
        structuredContent: reply,
      };
    },
  );

  return server;
}

/**
 * One endpoint per merchant.
 *
 * A single process rather than one per merchant: from a claimant's side these are still
 * distinct MCP servers at distinct URLs speaking real HTTP, and the simplification keeps
 * `pnpm demo` to four processes instead of six.
 */
export function createMerchantAgentsApp(
  configs: readonly MerchantConfig[] = STORYBOARD_MERCHANTS,
): Express {
  const app = createMcpExpressApp();
  const handlers = new Map(
    configs.map((config) => [
      merchantSlug(config.merchant),
      toNodeHandler(createMcpHandler(() => createMerchantMcpServer(config))),
    ]),
  );

  app.get("/merchants", (_req: Request, res: Response) => {
    res.json({
      merchants: configs.map((config) => ({
        merchant: config.merchant,
        path: `/mcp/${merchantSlug(config.merchant)}`,
      })),
    });
  });

  app.all("/mcp/:slug", (req: Request, res: Response) => {
    const slug = req.params.slug;
    const handler = handlers.get(typeof slug === "string" ? slug : "");
    if (handler === undefined) {
      res.status(404).json({ error: "unknown merchant" });
      return;
    }
    void handler(req, res, req.body);
  });

  return app;
}
