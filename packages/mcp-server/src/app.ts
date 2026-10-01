import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { type Clock, type FixedClock, project, SystemClock } from "@owed/core";
import type { Instant } from "@owed/domain";
import type { Express, NextFunction, Request, Response } from "express";
import type { AuthConfig } from "./auth/config.js";
import { householdFromAuth, requireOwedAuth, stripWwwAuthenticate } from "./auth/middleware.js";
import { createAuthRouter } from "./auth/router.js";
import { requireControlToken } from "./control/auth.js";
import type { OwedDeps } from "./deps.js";
import type { RecourseLog } from "./merchants/log.js";
import { commitmentsDue } from "./proactive/scheduler.js";
import { createOwedServer } from "./server.js";

export interface OwedAppOptions {
  deps: OwedDeps;
  /**
   * Account linking. When present, `/mcp` requires a bearer token and the household
   * comes from that token rather than from configuration.
   */
  auth?: {
    config: AuthConfig;
    /** Wall clock for token lifetimes — never the scrubbable scenario clock. */
    clock?: Clock;
    /**
     * Send an RFC 9728 `WWW-Authenticate` challenge on 401. Off by default for the
     * Alexa+ target; on is the right choice for generic MCP clients that rely on the
     * challenge for discovery. See docs/friction-log.md.
     */
    sendWwwAuthenticate?: boolean;
  };
  /** Exposed so the timeline scrubber can move scenario time. */
  scrubbableClock?: FixedClock;
  /**
   * The span the scrubber may move within.
   *
   * Published rather than assumed, so the home holds no knowledge of the scenario:
   * it draws whatever week it is handed.
   */
  scrubberRange?: { start: Instant; end: Instant };
  /** Exposed so the protocol inspector can show the recourse exchange. */
  recourseLog?: RecourseLog;
  /**
   * Bearer token for `/control/*`. Unset leaves them open, which is what the local demo
   * and every test want; a deployment sets it. See `src/control/auth.ts`.
   */
  controlToken?: string;
  /**
   * Extra hostnames to accept in `Host` and `Origin`, on top of the loopback names.
   *
   * Needed behind a reverse proxy: Caddy forwards the original `Host`, so the public
   * hostname arrives at a validator whose default allow-list is loopback only.
   */
  allowedHosts?: readonly string[];
}

/**
 * The HTTP surface.
 *
 * `createMcpExpressApp` validates `Host` and `Origin` before anything else — including
 * before the body parser — which is the DNS-rebinding protection the spec requires. It
 * does **not** bind anything despite its `host` option: the actual bind is the
 * `.listen()` in `main.ts`, and `host` only selects which validators get mounted.
 */
export function createOwedApp({
  deps,
  auth,
  scrubbableClock,
  scrubberRange,
  recourseLog,
  controlToken,
  allowedHosts = [],
}: OwedAppOptions): Express {
  const app = createOwedExpressApp(allowedHosts);

  if (auth?.sendWwwAuthenticate !== true) {
    // Applied first so nothing downstream can attach a challenge header.
    app.use(stripWwwAuthenticate());
  }

  const node = toNodeHandler(
    createMcpHandler((ctx: { authInfo?: unknown; era?: "legacy" | "modern" }) =>
      createOwedServer(
        { ...deps, householdId: householdFromAuth(ctx.authInfo) ?? deps.householdId },
        ctx.era ?? "legacy",
      ),
    ),
  );

  if (auth) {
    const clock = auth.clock ?? new SystemClock();
    app.use(createAuthRouter({ config: auth.config, clock, householdId: deps.householdId }));
    // Auth runs ahead of the MCP handler: the conformance probe sends no `Accept`
    // header, and a server that validated `Accept` first would answer 406 where the
    // check demands exactly 401.
    app.all("/mcp", requireOwedAuth({ config: auth.config }), forward(node));
  } else {
    app.all("/mcp", forward(node));
  }

  // Mounted before any `/control` route is registered, so adding a route later cannot
  // accidentally land outside the gate.
  app.use("/control", requireControlToken(controlToken));

  if (scrubbableClock) {
    mountScrubberControls(app, scrubbableClock, scrubberRange);
  }

  /**
   * The channel Alexa+ does not have.
   *
   * An add-on can only answer; it can never speak first. Owed's premise is noticing
   * what nobody asked about, so this endpoint stands in for the missing primitive and
   * hands the host everything Owed would say unprompted at the current instant. It is
   * a projection, not a queue: polling it twice is free, and moving the clock
   * backwards takes announcements away again.
   *
   * Deliberately outside the MCP surface, because it is not part of the add-on
   * contract — it is the shape of the request we are making of it. See
   * docs/proactive.md and src/proactive/commitment.ts.
   */
  /**
   * `async` rather than a synchronous handler firing a floating promise, and that is a
   * correctness fix rather than a tidy-up.
   *
   * This previously read `void (async () => { … })()`, which Express cannot see: a
   * rejection from `store.read` had nothing to catch it and became an unhandled rejection,
   * which Node answers by terminating the process. That was invisible while the ledger was
   * in memory, where a read cannot fail. Against DynamoDB it can — a throttle, a timeout,
   * an expired instance role — and the brain polls this endpoint every 1500 ms, so the
   * first hiccup would have taken the server down. Express 5 forwards a rejected async
   * handler to the error middleware at the foot of this function instead.
   */
  app.get("/control/commitments", async (_req: Request, res: Response) => {
    const now = deps.clock.now();
    const state = project(await deps.store.read(deps.householdId, now));
    res.json({ now, events: commitmentsDue(state, now, deps.householdId) });
  });

  if (recourseLog) {
    // An observation window, not part of the add-on contract — the same place the
    // scrubber's clock control lives, and for the same reason.
    app.get("/control/recourse", (req: Request, res: Response) => {
      const since = Number.parseInt(String(req.query.since ?? "0"), 10);
      res.json(recourseLog.since(Number.isFinite(since) ? since : 0));
    });
  }

  /**
   * Is the ledger actually readable?
   *
   * Deliberately touches the store rather than returning a constant. A process that is
   * listening but cannot reach DynamoDB is the failure worth detecting, and a `/health`
   * that only proves the event loop is turning would report it as fine. `limit`-less reads
   * are cheap here because a household's ledger is small and this is the same query the
   * tools run.
   *
   * 503 rather than 500: the service is temporarily unable, which is what a proxy and an
   * operator both need to hear.
   */
  app.get("/health", async (_req: Request, res: Response) => {
    try {
      const events = await deps.store.read(deps.householdId);
      res.json({ status: "ok", events: events.length });
    } catch (error) {
      res.status(503).json({ status: "unavailable", reason: describe(error) });
    }
  });

  /**
   * The last line before a request becomes a process exit.
   *
   * Registered after every route, because Express only treats a four-argument function as
   * error middleware and only consults it for errors raised downstream of where it is
   * mounted. Without this, a rejected async handler is an unhandled rejection, and Node's
   * answer to that is to terminate — which is a strange way to respond to one slow
   * database call.
   */
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    process.stderr.write(`owed: request failed: ${describe(error)}\n`);
    if (res.headersSent) return;
    res.status(503).json({ error: "unavailable", error_description: describe(error) });
  });

  return app;
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

type NodeHandler = ReturnType<typeof toNodeHandler>;

function forward(node: NodeHandler) {
  return (req: Request, res: Response) => void node(req, res, req.body);
}

/**
 * Loopback names in the exact spelling the validator compares against.
 *
 * It parses the header and matches the hostname with `Array.includes` — no wildcards, no
 * subdomains — and IPv6 is expected bracketed.
 */
const LOOPBACK_HOSTNAMES = ["localhost", "127.0.0.1", "[::1]"] as const;

/**
 * Three traps in this API, which is why this is a function and not an inline object.
 *
 * 1. `allowedHosts` **replaces** the built-in loopback list rather than extending it, so
 *    passing only a public hostname would 403 `pnpm demo`, the conformance probe and every
 *    test — they all talk to `127.0.0.1`. Hence the union.
 * 2. An empty array is *truthy*, so it mounts the validator with nothing permitted and
 *    rejects everything, loopback included. Hence the early return rather than passing
 *    `allowedHosts: [...LOOPBACK_HOSTNAMES]` always — with no extra hosts we want the
 *    package's own default behaviour, unchanged.
 * 3. `Host` and `Origin` are armed independently. Supplying only `allowedHosts` leaves
 *    Origin validation on the localhost-only list, so a browser on the public origin would
 *    pass the first check and fail the second. Both get the same list.
 */
function createOwedExpressApp(extraHosts: readonly string[]): Express {
  if (extraHosts.length === 0) return createMcpExpressApp();
  const allowed = [...new Set([...LOOPBACK_HOSTNAMES, ...extraHosts])];
  return createMcpExpressApp({ allowedHosts: allowed, allowedOrigins: allowed });
}

/**
 * Scrubber control, deliberately outside the MCP surface: moving scenario time is a
 * property of the simulated home, not something a real add-on may expose.
 */
function mountScrubberControls(
  app: Express,
  clock: FixedClock,
  range?: { start: Instant; end: Instant },
): void {
  app.get("/control/clock", (_req: Request, res: Response) => {
    res.json({ now: clock.now(), ...range });
  });

  app.post("/control/clock", (req: Request, res: Response) => {
    const instant = (req.body as { instant?: unknown } | undefined)?.instant;
    if (typeof instant !== "string") {
      res.status(400).json({ error: "expected { instant: string }" });
      return;
    }
    clock.set(instant);
    res.json({ now: clock.now() });
  });
}
