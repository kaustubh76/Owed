import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { linkAccount } from "@owed/mcp-server";

export type FrameListener = (direction: "out" | "in", message: unknown) => void;

/** What the home is told about the hop it cannot see. */
export type SessionStatus = "linking" | "live" | "lost";

export type StatusListener = (status: SessionStatus, detail?: string) => void;

/**
 * A live client, plus how long its credentials are good for.
 *
 * The lifetime is the part that was missing. `linkAccount` has always returned
 * `expiresInSeconds`; the brain discarded it, froze the access token into the transport's
 * request headers, and held the result for the life of the process — so one hour after
 * boot every call 401'd, with no crash to restart and no log line to find.
 */
export interface Established {
  client: Client;
  expiresInSeconds?: number;
}

export interface SessionOptions {
  url: URL;
  baseUrl: URL;
  clientId: string;
  onFrame: FrameListener;
  onStatus?: StatusListener;
  /**
   * A token supplied out of band, which skips linking.
   *
   * It also cannot be renewed, so a session built on one gets no renewal timer — there
   * would be nothing to renew it with.
   */
  staticToken?: string;
  /**
   * How a session is established. Defaults to the real link-and-connect below.
   *
   * Injectable for the same reason the Bedrock extractor's `invoke` is: everything
   * interesting here is *lifecycle* — when to rebuild, how long to wait, what to tell the
   * home — and none of that should need a running server to test. The real adapter is the
   * only part that does.
   */
  connect?: () => Promise<Established>;
}

/**
 * Everything the brain needs from its MCP session, with the session's lifetime managed.
 *
 * `call` is the only way in, which is deliberate. The brain used to hold a `Client`
 * forever, and that was wrong in two ways that ended in the same place — a demo that looks
 * connected and answers nothing:
 *
 *  1. **Tokens expire** (see `Established`).
 *  2. **Servers restart.** The MCP server runs under `Restart=always`. `Client` reports a
 *     dead transport through `onclose`/`onerror`, and nothing was assigning either, so a
 *     dead session was indistinguishable from a live one.
 *
 * Both are the same problem — a session is not permanent — so both get the same fix: hold
 * a *way to get* a session rather than a session, and rebuild it when it goes.
 */
export interface SessionHandle {
  call<T>(use: (client: Client) => Promise<T>): Promise<T>;
  /**
   * Establish the session now rather than on first use.
   *
   * Called at boot so the brain binds its WebSocket only once it can reach the server —
   * which is what makes "brain connected" in the home a readiness signal worth waiting
   * for, as `docs/demo-script.md` tells a presenter it is, rather than a claim about one of
   * two hops.
   */
  ready(): Promise<void>;
  /** Drop the session, so the next `call` builds a fresh one. */
  invalidate(reason: string): void;
  stop(): void;
}

/** Renew at this fraction of the token's life, leaving room for clock skew and a retry. */
export const RENEW_AT = 0.8;

const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 30_000;

export function openSession(options: SessionOptions): SessionHandle {
  const { onStatus } = options;
  const connect = options.connect ?? (() => linkAndConnect(options));

  let session: Promise<Client> | undefined;
  let renewTimer: NodeJS.Timeout | undefined;
  let failures = 0;
  let stopped = false;
  /** Distinguishes "my attempt failed" from "a newer attempt replaced me". */
  let epoch = 0;

  const announce = (status: SessionStatus, detail?: string) => onStatus?.(status, detail);

  function clearRenew(): void {
    if (renewTimer !== undefined) clearTimeout(renewTimer);
    renewTimer = undefined;
  }

  function invalidate(reason: string): void {
    if (session === undefined) return;
    session = undefined;
    clearRenew();
    process.stderr.write(`owed brain: session lost (${reason})\n`);
    announce("lost", reason);
  }

  async function establish(): Promise<Client> {
    announce("linking");
    const { client, expiresInSeconds } = await connect();

    client.onclose = () => invalidate("transport closed");
    client.onerror = (error) => invalidate(error instanceof Error ? error.message : String(error));

    if (expiresInSeconds !== undefined && expiresInSeconds > 0) {
      clearRenew();
      // Unref'd: a pending renewal must never be the reason the process stays alive.
      renewTimer = setTimeout(
        () => invalidate("token nearing expiry"),
        Math.max(1, Math.floor(expiresInSeconds * RENEW_AT)) * 1000,
      );
      renewTimer.unref?.();
    }

    failures = 0;
    announce("live");
    return client;
  }

  /**
   * One shared in-flight attempt, so N queued calls during an outage produce one link
   * rather than N. Backoff grows on consecutive failures and resets on success.
   */
  function ensure(): Promise<Client> {
    if (stopped) return Promise.reject(new Error("session stopped"));
    if (session !== undefined) return session;

    const delay =
      failures === 0 ? 0 : Math.min(RECONNECT_BASE_MS * 2 ** (failures - 1), RECONNECT_MAX_MS);
    const generation = ++epoch;

    const attempt = (async () => {
      if (delay > 0) {
        await new Promise((resolve) => {
          setTimeout(resolve, delay).unref?.();
        });
      }
      try {
        return await establish();
      } catch (error) {
        failures += 1;
        // Cleared so the next call retries rather than re-awaiting a rejected promise — a
        // cached rejection would make one bad moment permanent, which is exactly the bug
        // the merchant client cache has.
        if (epoch === generation) session = undefined;
        announce("lost", error instanceof Error ? error.message : String(error));
        throw error;
      }
    })();

    session = attempt;
    return attempt;
  }

  return {
    async call<T>(use: (client: Client) => Promise<T>): Promise<T> {
      try {
        return await use(await ensure());
      } catch (error) {
        // One retry, because the overwhelmingly likely cause of a first failure is a
        // session that expired or a server that restarted — both fixed by rebuilding and
        // asking again. A second failure is a real one and is reported.
        invalidate(error instanceof Error ? error.message : String(error));
        if (stopped) throw error;
        return await use(await ensure());
      }
    },
    async ready(): Promise<void> {
      await ensure();
    },
    invalidate,
    stop(): void {
      stopped = true;
      clearRenew();
      const closing = session;
      session = undefined;
      void closing?.then((client) => client.close()).catch(() => {});
    },
  };
}

/**
 * The real adapter: walk the auth flow, open the transport, tap the frames.
 *
 * Re-linking rather than exchanging the refresh token is a deliberate simplification. This
 * client is static and reaches the authorization server over loopback, so a fresh
 * authorization-code + PKCE walk costs nothing and exercises the same path the demo
 * advertises. A real client — one whose walk needs a person at a consent screen — would use
 * `LinkResult.refreshToken` instead, which is why `linkAccount` returns it.
 */
async function linkAndConnect(options: SessionOptions): Promise<Established> {
  const { url, baseUrl, clientId, onFrame, staticToken } = options;

  const link = staticToken === undefined ? await linkAccount({ baseUrl, clientId }) : undefined;
  const accessToken = staticToken ?? link?.accessToken;
  if (accessToken === undefined) throw new Error("no access token after linking");

  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
  });

  const send = transport.send.bind(transport);
  transport.send = async (message, request) => {
    onFrame("out", message);
    return send(message, request);
  };

  const client = new Client({ name: "owed-brain", version: "0.1.0" });
  await client.connect(transport);

  // `connect` installs the client's own handler; wrap it once it is in place.
  const installed = transport.onmessage?.bind(transport);
  transport.onmessage = (message) => {
    onFrame("in", message);
    installed?.(message);
  };

  process.stdout.write(`owed brain: linked to ${url.href}\n`);
  return {
    client,
    ...(link?.expiresInSeconds === undefined ? {} : { expiresInSeconds: link.expiresInSeconds }),
  };
}
