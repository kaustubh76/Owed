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
  /**
   * Ceilings, overridable so a test can prove them without waiting them out.
   *
   * Defaults are the two constants below, which are what the server runs with.
   */
  timeouts?: { connectMs?: number; respondMs?: number };
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

/**
 * How long the handshake before the first round may take.
 *
 * The same argument as `RESPOND_TIMEOUT_MS`, which had an explicit ceiling while the
 * `connect` that precedes it had none — so the SDK's 60s default applied to `initialize`,
 * and a merchant that accepted the TCP connection and never answered held `claim_file`
 * open for a minute before a single round had happened.
 *
 * Sixty seconds is also longer than the brain's own untimed `callTool`, which falls back to
 * the same default: the brain gave up first, invalidated its session and retried the whole
 * tool call while the server was still waiting on the handshake. Nothing deduplicated that;
 * `claim_file` being idempotent per promise is the only reason it was not a second claim.
 */
const CONNECT_TIMEOUT_MS = 5_000;

export function httpMerchants({ baseUrl, log, timeouts }: HttpMerchantsOptions): MerchantDirectory {
  const connectMs = timeouts?.connectMs ?? CONNECT_TIMEOUT_MS;
  const respondMs = timeouts?.respondMs ?? RESPOND_TIMEOUT_MS;
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
    await client.connect(transport, { timeout: connectMs });

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

  /**
   * Forget a session so the next claim reconnects — and close the one being dropped.
   *
   * The close was missing. `forget` runs on every failed negotiation round, so each one
   * abandoned a live `Client` and its `StreamableHTTPClientTransport`, with nothing to
   * abort an in-flight request or close a stream it still held.
   *
   * Not a file-descriptor leak, which is worth saying plainly because it would be the
   * easy thing to claim: sockets here belong to the runtime's global connection pool, and
   * measuring `server.getConnections()` across a negotiation and a close shows the same
   * count either way. What leaked is the client and whatever it was still waiting on.
   *
   * Nothing on these clients is wired to `onclose`, so unlike the brain's session there is
   * no handler to detach first.
   */
  function forget(merchant: string): void {
    const dropped = clients.get(merchant);
    clients.delete(merchant);
    // A close that fails is not news: the usual reason to be here is that the merchant
    // already went away.
    void dropped?.then((client) => client.close()).catch(() => {});
  }

  return {
    /**
     * Close every merchant session on the way out.
     *
     * `shutdown()` closed the HTTP listener and the ledger and left these open, which is
     * why `readme.md` could say "all three services close their listeners and the store"
     * and be exactly, narrowly true.
     *
     * The map is cleared, so the directory is still usable afterwards rather than left
     * holding closed clients — a shutdown that raced an in-flight claim would otherwise
     * leave every later claim talking to a dead session. `http.test.ts` pins that, and
     * that this is safe to call twice, and on a directory that never connected to
     * anything.
     */
    async close(): Promise<void> {
      const open = [...clients.values()];
      clients.clear();
      await Promise.all(
        open.map((client) =>
          client
            .then((c) => c.close())
            .catch(() => {
              // Teardown reports nothing: a merchant that has already gone is the common case.
            }),
        ),
      );
    },

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
              { timeout: respondMs },
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
