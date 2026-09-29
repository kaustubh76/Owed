import { RESOURCE_MIME_TYPE, registerAppResource } from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/server";
import type { OwedDeps } from "./deps.js";
import { registerClaimFile } from "./tools/claimFile.js";
import { registerLedgerSummary } from "./tools/ledgerSummary.js";
import { registerPromisesList } from "./tools/promisesList.js";
import { registerReadTools } from "./tools/reads.js";
import { loadViewHtml, VIEW_URIS, type ViewName } from "./views.js";

export const SERVER_INFO = { name: "owed", version: "0.1.0" } as const;

/** These views fetch nothing and talk to nobody but their host. */
const DENY_BY_DEFAULT_CSP = { csp: { resourceDomains: [], connectDomains: [] } };

function registerView(server: McpServer, name: ViewName): void {
  const uri = VIEW_URIS[name];
  registerAppResource(
    server,
    `Owed ${name} card`,
    uri,
    {
      mimeType: RESOURCE_MIME_TYPE,
      // Deny-by-default: these views talk to nothing but their host.
      _meta: { ui: DENY_BY_DEFAULT_CSP },
    },
    async () => ({
      contents: [
        {
          uri,
          mimeType: RESOURCE_MIME_TYPE,
          text: await loadViewHtml(name),
          // Repeated on the content item because that is where a host reads it from;
          // the listing entry is only a fallback.
          _meta: { ui: DENY_BY_DEFAULT_CSP },
        },
      ],
    }),
  );
}

/** Which protocol revision this connection is speaking. */
export type ProtocolEra = "legacy" | "modern";

/** A fresh server per request; all shared state lives in `deps`. */
export function createOwedServer(deps: OwedDeps, era: ProtocolEra = "legacy"): McpServer {
  const server = new McpServer(SERVER_INFO);
  registerLedgerSummary(server, deps);
  registerPromisesList(server, deps);
  registerReadTools(server, deps);
  registerClaimFile(server, deps, era);

  registerView(server, "ledger");
  registerView(server, "claim");
  registerView(server, "evidence");
  return server;
}
