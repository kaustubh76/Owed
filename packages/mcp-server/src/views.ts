import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { viewEntry } from "@owed/ui-views";

/** The three `ui://` views — frozen, docs/contract-v1.md §3. */
export const VIEW_URIS = {
  ledger: "ui://owed/ledger",
  claim: "ui://owed/claim",
  evidence: "ui://owed/evidence",
} as const;

export type ViewName = keyof typeof VIEW_URIS;

/**
 * Who may call Owed's tools: the model, and never a view.
 *
 * MCP Apps lets a tool declare `_meta.ui.visibility`, and the published default is
 * **`["model", "app"]`** — the schema in `@modelcontextprotocol/ext-apps` says so in as many
 * words. Owed declared nothing, so under that default every tool was callable from inside a
 * view, **including `claim_file`**, which argues with a merchant over HTTP and appends to the
 * ledger. A view is sandboxed, opaque-origin HTML: the least trusted surface here, and the one
 * that could reach the only irreversible tool.
 *
 * It had never been exercised, because Owed's own host cannot make that call: `EchoShow.tsx`
 * builds its `AppBridge` with a null client, and the SDK only wires `oncalltool` when a client
 * is present. So the gap was invisible from inside this repo and opened the moment any other
 * spec-compliant host — a real Alexa+, or the third-party client in
 * `apps/brain/src/alexaPlusClient.test.ts` — rendered a card.
 *
 * The three views never call a tool. `shared/useOwedView.ts` declares `capabilities: {}` and
 * handles exactly `ontoolresult` and `onhostcontextchanged`; they are display surfaces. So the
 * honest declaration is the narrow one, and nothing is lost by making it.
 *
 * Spread at each use rather than shared by reference, so no tool's metadata can be mutated
 * through another's. Recorded as amendment D26.
 */
export const MODEL_ONLY: readonly ["model"] = ["model"] as const;

const require = createRequire(import.meta.url);

/**
 * Read a built view.
 *
 * Each view is one self-contained HTML file with every asset inlined, because an MCP
 * Apps resource is delivered as a single document into a sandboxed iframe that cannot
 * fetch anything else.
 */
export async function loadViewHtml(name: ViewName): Promise<string> {
  // `viewEntry` is `@owed/ui-views`'s own statement of where a built view lands. Spelling
  // the path out here instead left two definitions of it, one of them in a barrel that
  // said it existed so a host "does not have to spell the URIs out and get them subtly
  // wrong" — while this file did exactly that.
  const specifier = `@owed/ui-views/${viewEntry(name)}`;
  let path: string;
  try {
    path = require.resolve(specifier);
  } catch (cause) {
    throw new Error(`view "${name}" is not built. Run: pnpm --filter @owed/ui-views build`, {
      cause,
    });
  }
  return readFile(path, "utf8");
}
