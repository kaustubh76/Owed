import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { merchantSlug } from "@owed/merchant-agents";
import {
  type RecourseMessage,
  type Respondent,
  type RespondentMessage,
  RespondentMessageSchema,
} from "@owed/recourse-protocol";
import type { MerchantDirectory } from "./directory.js";
import type { RecourseLog } from "./log.js";

export interface HttpMerchantsOptions {
  /** Where the merchant agents are served. Each is mounted at `/mcp/<slug>`. */
  baseUrl: URL;
  /** Where the exchange is recorded so the inspector can show it. */
  log?: RecourseLog;
}

/**
 * Merchant agents reached over MCP.
 *
 * The `remedy` argument is deliberately ignored. A merchant is authoritative about its
 * own published terms, so this asks rather than tells — which is both more honest and a
 * better demonstration of what the protocol is for.
 *
 * Frames are tapped at the transport, the same way the brain taps its own, because the
 * inspector's claim is that it shows what actually went over the wire.
 */
export function httpMerchants({ baseUrl, log }: HttpMerchantsOptions): MerchantDirectory {
  const clients = new Map<string, Promise<Client>>();

  async function connect(merchant: string): Promise<Client> {
    const url = new URL(`/mcp/${merchantSlug(merchant)}`, baseUrl);
    const transport = new StreamableHTTPClientTransport(url);

    const send = transport.send.bind(transport);
    transport.send = async (message, options) => {
      log?.append({ merchant, direction: "out", message });
      return send(message, options);
    };

    const client = new Client({ name: "owed-recourse", version: "0.1.0" });
    await client.connect(transport);

    const installed = transport.onmessage?.bind(transport);
    transport.onmessage = (message) => {
      log?.append({ merchant, direction: "in", message });
      installed?.(message);
    };

    return client;
  }

  function clientFor(merchant: string): Promise<Client> {
    const existing = clients.get(merchant);
    if (existing !== undefined) return existing;
    const created = connect(merchant);
    clients.set(merchant, created);
    return created;
  }

  return {
    respondentFor(merchant: string): Respondent {
      return {
        name: merchant,
        async respond(transcript: readonly RecourseMessage[]): Promise<RespondentMessage> {
          const client = await clientFor(merchant);
          const result = await client.callTool({
            name: "recourse_respond",
            arguments: { transcript },
          });

          const parsed = RespondentMessageSchema.safeParse(result.structuredContent);
          if (!parsed.success) {
            throw new Error(`${merchant} answered with something that is not a recourse message`);
          }
          return parsed.data;
        },
      };
    },
  };
}
