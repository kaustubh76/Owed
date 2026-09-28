import { RESOURCE_MIME_TYPE, registerAppResource } from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/server";
import type { OwedDeps } from "./deps.js";
import { registerLedgerSummary } from "./tools/ledgerSummary.js";
import { loadViewHtml, VIEW_URIS, type ViewName } from "./views.js";

export const SERVER_INFO = { name: "owed", version: "0.1.0" } as const;

function registerView(server: McpServer, name: ViewName): void {
  const uri = VIEW_URIS[name];
  registerAppResource(
    server,
    `Owed ${name} card`,
    uri,
    {
      mimeType: RESOURCE_MIME_TYPE,
      // Deny-by-default: these views talk to nothing but their host.
      _meta: { ui: { csp: { resourceDomains: [], connectDomains: [] } } },
    },
    async () => ({
      contents: [{ uri, mimeType: RESOURCE_MIME_TYPE, text: await loadViewHtml(name) }],
    }),
  );
}

/** A fresh server per request; all shared state lives in `deps`. */
export function createOwedServer(deps: OwedDeps): McpServer {
  const server = new McpServer(SERVER_INFO);
  registerLedgerSummary(server, deps);
  registerView(server, "ledger");
  return server;
}
