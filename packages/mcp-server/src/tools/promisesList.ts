import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/server";
import { summarize } from "@owed/core";
import { type LedgerSummaryView, LedgerSummaryViewSchema, PromiseStatusSchema } from "@owed/domain";
import * as z from "zod/v4";
import type { OwedDeps } from "../deps.js";
import { VIEW_URIS } from "../views.js";
import { speakPromisesList } from "../voice.js";
import { loadContext } from "./context.js";

export function registerPromisesList(server: McpServer, deps: OwedDeps): void {
  registerAppTool(
    server,
    "promises_list",
    {
      title: "List promises",
      description:
        "List the promises made to this household, optionally narrowed to a status or a merchant. Answers 'what is Owed watching?' and 'what has Northwind promised me?'",
      inputSchema: z.object({
        status: PromiseStatusSchema.optional().describe("Only promises in this state."),
        merchant: z.string().optional().describe("Only promises from this merchant."),
      }),
      outputSchema: LedgerSummaryViewSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
      _meta: {
        ui: {
          resourceUri: VIEW_URIS.ledger,
          invoking: "Looking through your promises",
          invoked: "Here is what I am watching",
        },
      },
    },
    async ({ status, merchant }) => {
      const context = await loadContext(deps);
      const totals = summarize(context.state, deps.currency);

      const items = totals.items.filter(
        (item) =>
          (status === undefined || item.status === status) &&
          (merchant === undefined || item.merchant === merchant),
      );

      const view: LedgerSummaryView = {
        ...totals,
        items,
        period: "week",
        as_of: context.now,
      };

      return {
        content: [{ type: "text", text: speakPromisesList(view, { status, merchant }) }],
        structuredContent: view,
        _meta: { ui: { resourceUri: VIEW_URIS.ledger }, "owed/data": view },
      };
    },
  );
}
