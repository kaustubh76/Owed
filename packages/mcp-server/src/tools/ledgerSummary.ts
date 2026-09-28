import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/server";
import { project, summarize } from "@owed/core";
import {
  addMs,
  DAY_MS,
  type LedgerPeriod,
  LedgerPeriodSchema,
  type LedgerSummaryView,
  LedgerSummaryViewSchema,
} from "@owed/domain";
import * as z from "zod/v4";
import type { OwedDeps } from "../deps.js";
import { VIEW_URIS } from "../views.js";
import { speakLedgerSummary } from "../voice.js";

const PERIOD_DAYS: Readonly<Record<LedgerPeriod, number>> = { week: 7, month: 30 };

export function registerLedgerSummary(server: McpServer, deps: OwedDeps): void {
  registerAppTool(
    server,
    "ledger_summary",
    {
      title: "What am I owed",
      description:
        "Total what this household has recovered from broken promises and what is still open. Answers 'what am I owed?'",
      inputSchema: z.object({
        period: LedgerPeriodSchema.optional().describe("Defaults to the past week."),
      }),
      outputSchema: LedgerSummaryViewSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
      _meta: {
        ui: {
          resourceUri: VIEW_URIS.ledger,
          invoking: "Checking your ledger",
          invoked: "Here is what you are owed",
        },
      },
    },
    async ({ period }) => {
      const view = await buildLedgerSummary(deps, period ?? "week");
      return {
        // Exactly one content block, self-sufficient when read aloud (plan §6.5).
        content: [{ type: "text", text: speakLedgerSummary(view) }],
        structuredContent: view,
        _meta: { ui: { resourceUri: VIEW_URIS.ledger }, "owed/data": view },
      };
    },
  );
}

export async function buildLedgerSummary(
  deps: OwedDeps,
  period: LedgerPeriod,
): Promise<LedgerSummaryView> {
  const now = deps.clock.now();
  const since = addMs(now, -PERIOD_DAYS[period] * DAY_MS);
  const state = project(await deps.store.read(deps.householdId, now));
  return { ...summarize(state, deps.currency, since), period, as_of: now };
}
