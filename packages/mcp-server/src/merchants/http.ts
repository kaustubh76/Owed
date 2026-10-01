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
/**
 * How long one negotiation round may take.
 *
 * Chosen to be noticeably shorter than the SDK's 60s default: a household asking "file it"
 * should hear an answer or a failure, and three rounds at a minute each is neither.
 */
const RESPOND_TIMEOUT_MS = 10_000;

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

  /**
   * A connection per merchant, cached — but never a *failure* cached.
   *
   * The promise is stored before it settles, which is what makes concurrent claims against
   * the same merchant share one connection. The bug that created was permanence: nothing
   * removed a rejected promise, so once a merchant was briefly unreachable, every later
   * claim re-awaited the same rejection for the life of the process. Restarting the
   * merchant agents did not help; only restarting this server did, and the agents are
   * ordered to start *first*, so a `systemctl restart owed-merchants` left the MCP server
   * running and permanently broken against every merchant.
   *
   * Dropping the entry on rejection means the next claim tries again, which is all the
   * recovery this needs.
   */
  function clientFor(merchant: string): Promise<Client> {
    const existing = clients.get(merchant);
    if (existing !== undefined) return existing;

    const created = connect(merchant).catch((error: unknown) => {
      if (clients.get(merchant) === created) clients.delete(merchant);
      throw error;
    });
    clients.set(merchant, created);
    return created;
  }

  /** Forget a session so the next claim reconnects. */
  function forget(merchant: string): void {
    clients.delete(merchant);
  }

  return {
    respondentFor(merchant: string): Respondent {
      return {
        name: merchant,
        async respond(transcript: readonly RecourseMessage[]): Promise<RespondentMessage> {
          const client = await clientFor(merchant);
          let result: Awaited<ReturnType<Client["callTool"]>>;
          try {
            result = await client.callTool(
              { name: "recourse_respond", arguments: { transcript } },
              // An explicit ceiling. Without one the client SDK's 60s default applies per
              // request, and a negotiation runs up to three rounds — so one unresponsive
              // merchant could hold a claim open for minutes while the household waited.
              { timeout: RESPOND_TIMEOUT_MS },
            );
          } catch (error) {
            // A failed call means this session is suspect, not just this request. Dropping
            // it is what turns "the merchant restarted" into one failed claim rather than
            // every future claim.
            forget(merchant);
            throw error;
          }

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
