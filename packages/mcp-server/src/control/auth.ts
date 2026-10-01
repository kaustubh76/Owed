import { createHash, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";

/**
 * Bearer gate for `/control/*`.
 *
 * Those routes are not part of the add-on contract — they are the simulated home's
 * controls and the stand-in for the proactive channel Alexa+ does not have — and they are
 * the only routes in the app that were never behind `requireOwedAuth`. On a loopback demo
 * that is correct and costs nothing. On a public origin it is three ledger leaks and one
 * unauthenticated write:
 *
 *  - `GET /control/recourse` returns the verbatim MCP payloads of every negotiation
 *  - `GET /control/commitments` names merchants and amounts in its `spoken` line
 *  - `POST /control/clock` moves scenario time for every client at once
 *
 * **Why a token rather than a remote-address check.** The obvious defence — only accept
 * connections from `127.0.0.1` — is worthless in the deployment it is meant to protect,
 * because Caddy sits on the same box and every proxied request therefore arrives *from*
 * loopback. It would read like a guard and function as a no-op. A shared secret does not
 * care how the request was routed.
 *
 * Unset means open, so `pnpm demo` and the test harness behave exactly as before. That is
 * a deliberate default: the deployment is the unusual case, and requiring a token locally
 * would mean four processes needing configuration to do what they already do.
 */
export function requireControlToken(token: string | undefined): RequestHandler {
  if (token === undefined || token === "") {
    return (_req: Request, _res: Response, next: NextFunction) => next();
  }

  const expected = digest(token);

  return (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization;
    if (typeof header !== "string" || !header.toLowerCase().startsWith("bearer ")) {
      unauthorized(res, "control endpoints require a bearer token");
      return;
    }
    // Compared as fixed-length digests so the comparison cannot leak the token's length,
    // and so `timingSafeEqual` — which throws on mismatched lengths — is always safe.
    if (!timingSafeEqual(digest(header.slice("bearer ".length).trim()), expected)) {
      unauthorized(res, "control token does not match");
      return;
    }
    next();
  };
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function unauthorized(res: Response, description: string): void {
  // Same shape as the `/mcp` gate, and 401 rather than 404: pretending the routes are not
  // there would make a misconfigured deployment look like a routing bug for as long as it
  // took somebody to read this file.
  res.status(401).json({ error: "invalid_token", error_description: description });
}
