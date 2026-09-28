import { useApp } from "@modelcontextprotocol/ext-apps/react";
import { useState } from "react";
import { applyTheme } from "./theme.js";

export interface ParseResult<T> {
  success: boolean;
  data?: T;
}

export interface OwedViewOptions<T> {
  name: string;
  parse: (value: unknown) => ParseResult<T>;
}

export interface OwedViewState<T> {
  data: T | null;
  status: string;
}

/**
 * Read a tool result's payload.
 *
 * `structuredContent` is the documented home for it. `_meta["owed/data"]` is a
 * fallback, because every tool result here carries exactly one *spoken* text block
 * — there is no JSON content block to fall back to, and whether a given host
 * forwards `structuredContent` to the view is not something we get to assume.
 */
function readPayload(result: unknown): unknown {
  if (typeof result !== "object" || result === null) return undefined;
  const record = result as { structuredContent?: unknown; _meta?: Record<string, unknown> };
  return record.structuredContent ?? record._meta?.["owed/data"];
}

function readTheme(context: unknown): string | undefined {
  if (typeof context !== "object" || context === null) return undefined;
  const theme = (context as { theme?: unknown }).theme;
  return typeof theme === "string" ? theme : undefined;
}

/** Shared wiring for every `ui://owed/*` view: connect, parse, theme, report. */
export function useOwedView<T>({ name, parse }: OwedViewOptions<T>): OwedViewState<T> {
  const [data, setData] = useState<T | null>(null);
  const [status, setStatus] = useState("Connecting to Owed…");

  useApp({
    appInfo: { name, version: "1.0.0" },
    capabilities: {},
    onAppCreated: (app) => {
      app.ontoolresult = (result) => {
        const parsed = parse(readPayload(result));
        if (parsed.success && parsed.data !== undefined) {
          setData(parsed.data);
        } else {
          setStatus("Owed sent something this card could not read.");
        }
      };
      app.onhostcontextchanged = (context) => applyTheme(readTheme(context));
      app.onerror = () => setStatus("Lost the connection to Owed.");
    },
  });

  return { data, status };
}
