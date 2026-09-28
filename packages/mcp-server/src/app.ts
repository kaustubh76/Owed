import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { type Clock, type FixedClock, SystemClock } from "@owed/core";
import type { Express, Request, Response } from "express";
import type { AuthConfig } from "./auth/config.js";
import { householdFromAuth, requireOwedAuth, stripWwwAuthenticate } from "./auth/middleware.js";
import { createAuthRouter } from "./auth/router.js";
import type { OwedDeps } from "./deps.js";
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
}

/**
 * The HTTP surface.
 *
 * `createMcpExpressApp` binds to localhost and validates `Host`/`Origin` before
 * anything else, which is the DNS-rebinding protection the spec requires.
 */
export function createOwedApp({ deps, auth, scrubbableClock }: OwedAppOptions): Express {
  const app = createOwedExpressApp();

  if (auth?.sendWwwAuthenticate !== true) {
    // Applied first so nothing downstream can attach a challenge header.
    app.use(stripWwwAuthenticate());
  }

  const node = toNodeHandler(
    createMcpHandler((ctx: { authInfo?: unknown }) =>
      createOwedServer({
        ...deps,
        householdId: householdFromAuth(ctx.authInfo) ?? deps.householdId,
      }),
    ),
  );

  if (auth) {
    const clock = auth.clock ?? new SystemClock();
    app.use(createAuthRouter({ config: auth.config, clock, householdId: deps.householdId }));
    // Auth runs ahead of the MCP handler: the conformance probe sends no `Accept`
    // header, and a server that validated `Accept` first would answer 406 where the
    // check demands exactly 401.
    app.all("/mcp", requireOwedAuth({ config: auth.config, clock }), forward(node));
  } else {
    app.all("/mcp", forward(node));
  }

  if (scrubbableClock) {
    mountScrubberControls(app, scrubbableClock);
  }

  return app;
}

type NodeHandler = ReturnType<typeof toNodeHandler>;

function forward(node: NodeHandler) {
  return (req: Request, res: Response) => void node(req, res, req.body);
}

function createOwedExpressApp(): Express {
  return createMcpExpressApp();
}

/**
 * Scrubber control, deliberately outside the MCP surface: moving scenario time is a
 * property of the simulated home, not something a real add-on may expose.
 */
function mountScrubberControls(app: Express, clock: FixedClock): void {
  app.get("/control/clock", (_req: Request, res: Response) => {
    res.json({ now: clock.now() });
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
