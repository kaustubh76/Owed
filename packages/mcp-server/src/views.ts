import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

/** The three `ui://` views — frozen, docs/contract-v1.md §3. */
export const VIEW_URIS = {
  ledger: "ui://owed/ledger",
  claim: "ui://owed/claim",
  evidence: "ui://owed/evidence",
} as const;

export type ViewName = keyof typeof VIEW_URIS;

const require = createRequire(import.meta.url);

/**
 * Read a built view.
 *
 * Each view is one self-contained HTML file with every asset inlined, because an MCP
 * Apps resource is delivered as a single document into a sandboxed iframe that cannot
 * fetch anything else.
 */
export async function loadViewHtml(name: ViewName): Promise<string> {
  const specifier = `@owed/ui-views/views/${name}/index.html`;
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
