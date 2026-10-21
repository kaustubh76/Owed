import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";
import {
  assessPromises,
  type Clock,
  capturePromises,
  type FixedClock,
  project,
  type SiblingVerdict,
  SystemClock,
  TRACKING_CONFIDENCE,
} from "@owed/core";
import {
  type Evidence,
  EvidenceSchema,
  type Instant,
  type Interval,
  type ObservationWindow,
  ObservationWindowSchema,
  toEpochMs,
} from "@owed/domain";
import { extractPromises } from "@owed/extractor";
import type { Express, NextFunction, Request, Response } from "express";
import type { AuthConfig } from "./auth/config.js";
import { householdFromAuth, requireOwedAuth, stripWwwAuthenticate } from "./auth/middleware.js";
import { createAuthRouter } from "./auth/router.js";
import { requireControlToken } from "./control/auth.js";
import type { OwedDeps } from "./deps.js";
import type { RecourseLog } from "./merchants/log.js";
import { commitmentsDue } from "./proactive/scheduler.js";
import { CURRENCY, SEED_UTC_OFFSET } from "./seed/storyboard.js";
import { createOwedServer } from "./server.js";

/**
 * Run the breach engine over whatever the household has not had judged yet.
 *
 * **The gap this closes.** `PromiseAssessed` was emitted in exactly one place —
 * `seed/build.ts` — so the engine ran once, when the seeded week was built, and never
 * again. A promise captured at runtime through `/control/messages` was written to the
 * ledger and never judged, for any kind. Seven detectors and the coverage gate were
 * reachable only from the seed builder, and `promise_check` answered "I'm still watching"
 * about a promise nothing was watching.
 *
 * **A promise is judged when it has never been judged, and re-judged when something new
 * bearing on it has arrived since.** The first draft only did the former, which read as a
 * reasonable conservatism and was in fact useless: a judge posting a message and then the
 * evidence for it watched the verdict never move, because the promise had already been
 * judged — on no evidence — the moment it was captured.
 *
 * "Bearing on it" is narrow on purpose. Evidence tagged to the promise counts, and uptime
 * counts only where it overlaps the interval that promise was judged over. Household-wide
 * uptime does not re-open every verdict in the ledger, which is what keeps the seeded week
 * still: nothing new arrives for it at runtime, so none of its promises qualify. That is
 * asserted rather than assumed — `messages.test.ts` and `evidence.test.ts` both check the
 * storyboard's figures across a live post, the golden test pins them, and `verify:ui` reads
 * three of them out of a browser.
 *
 * Existing assessments are passed in as `known`, because a derived promise inherits from its
 * sibling and that sibling may have been judged in an earlier request.
 */
async function assessWhatIsPending(
  deps: OwedDeps,
  now: Instant,
  /**
   * The first `seq` this request wrote. Anything from here up is what just arrived.
   *
   * Scoped to the request rather than to "newer than the verdict", which was the first
   * attempt and was wrong in a way worth recording: the seeded week interleaves its arcs, so
   * a later arc's uptime carries a higher `seq` than an earlier arc's assessment and overlaps
   * its interval. Every delivered message then re-judged six seeded promises as well as its
   * own. The figures survived it, which is exactly why it would have gone unnoticed.
   */
  floor?: number,
): Promise<number> {
  // Raw events as well as the projection, because the decision below turns on ledger
  // *order* and the projection keeps none.
  const stored = await deps.store.read(deps.householdId, now);
  const state = project(stored);
  const views = [...state.promises.values()];

  const known: SiblingVerdict[] = views.flatMap((view) =>
    view.assessment === undefined ? [] : [{ promise: view.promise, detection: view.assessment }],
  );

  const overlaps = (a: Interval, b: Interval) =>
    toEpochMs(a.start) < toEpochMs(b.end) && toEpochMs(a.end) > toEpochMs(b.start);

  /**
   * By `seq`, not by time.
   *
   * The obvious reading of "has anything new arrived since this was judged?" is a timestamp
   * comparison, and it cannot work here: the scrubber runs on a `FixedClock`, so a verdict
   * reached at the current instant and an item posted a moment later carry the *same*
   * `recorded_at` and nothing ever looks newer. `seq` is the ledger's monotonic order — the
   * reason §12 makes it the DynamoDB sort key instead of time — so it answers the question
   * time cannot.
   */
  const assessedAtSeq = new Map<string, number>();
  for (const event of stored) {
    if (event.type === "PromiseAssessed") {
      assessedAtSeq.set(event.assessment.promise_id, event.seq);
    }
  }

  const needsJudging = views.filter((view) => {
    const judged = view.assessment;
    const since = assessedAtSeq.get(view.promise.id);
    if (judged === undefined || since === undefined) return true;

    return stored.some((event) => {
      if (event.seq <= since) return false;
      if (floor !== undefined && event.seq < floor) return false;
      if (event.type === "EvidenceObserved") return event.evidence.promise_id === view.promise.id;
      if (event.type === "SourceUptimeRecorded") {
        return (
          event.window.household_id === view.promise.household_id &&
          overlaps(event.window.interval, judged.evaluation_interval)
        );
      }
      return false;
    });
  });

  const { events } = assessPromises({
    householdId: deps.householdId,
    promises: needsJudging.map((view) => view.promise),
    evidence: views.flatMap((view) => view.evidence),
    uptime: state.uptime,
    now,
    idGen: deps.idGen,
    known,
  });

  if (events.length > 0) await deps.store.append(events);
  return events.length;
}

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

  /**
   * Deliver a message to the household's inbox, and record whatever Owed reads out of it.
   *
   * The extraction pipeline existed and nothing ran it: the seeded week writes its
   * promises in directly and used the extractor only to recover the sentence behind one.
   * So `PromiseStatus`'s `Candidate` and `Captured` — both of which have had a label and a
   * sort rank in `ui-views` since they were declared — had no producer at all.
   *
   * This is the producer. A real add-on would read a linked inbox; a simulation delivers a
   * message, and this is the seam where that happens, alongside the clock control and for
   * the same reason: it is a property of the simulated home, not of the add-on contract,
   * so it is deliberately outside the MCP surface.
   *
   * What comes back is what Owed made of it, which is the point — a household watching
   * this sees that a weakly-read promise is recorded and *not* tracked, rather than
   * silently either acted on or discarded.
   */
  app.post("/control/messages", async (req: Request, res: Response) => {
    const body = req.body as Partial<Record<"id" | "merchant" | "subject" | "text", unknown>>;
    const merchant = body?.merchant;
    const text = body?.text;
    if (typeof merchant !== "string" || merchant === "" || typeof text !== "string") {
      res.status(400).json({ error: "expected { merchant: string, text: string, id?: string }" });
      return;
    }

    const receivedAt = deps.clock.now();
    /**
     * From the id generator, not from the clock.
     *
     * This was `msg_${receivedAt}`, and the demo's clock is **fixed** — so every message
     * delivered while the scrubber sits at one instant got the *same* id, and every promise
     * read out of them shared one `source_ref`. That was harmless while `source_ref` was
     * only provenance. It stopped being harmless when `derivedBreach` started reading it:
     * two unrelated messages became each other's siblings, so a `warranty` posted second
     * inherited the verdict of a `delivery_window` posted first and reported itself
     * **Breached** on evidence that had nothing to do with it. Overclaiming, by exactly the
     * mechanism built to prevent it.
     *
     * `deps.idGen` is shared with the seed and counter-based, so ids stay unique, readable
     * in the inspector, and deterministic on replay.
     */
    const messageId =
      typeof body.id === "string" && body.id !== "" ? body.id : deps.idGen.next("msg");
    const reads = extractPromises({
      id: messageId,
      merchant,
      received_at: receivedAt,
      // The offset the household's own merchants write times in, as the seeded week does.
      utc_offset: SEED_UTC_OFFSET,
      subject: typeof body.subject === "string" ? body.subject : "",
      body: text,
    });

    const { events, promises } = capturePromises({
      householdId: deps.householdId,
      messageId,
      merchant,
      receivedAt,
      currency: CURRENCY,
      reads,
      idGen: deps.idGen,
    });
    const appended = await deps.store.append(events);

    // Judge it now rather than never. A promise read out of a message with evidence already
    // on file — a window that closed before the receipt arrived — is decidable the moment it
    // is captured, and used to sit at `Captured` for the life of the process.
    await assessWhatIsPending(deps, receivedAt, appended[0]?.seq);
    const judged = project(await deps.store.read(deps.householdId, receivedAt));

    res.json({
      received_at: receivedAt,
      message_id: messageId,
      tracking_confidence: TRACKING_CONFIDENCE,
      promises: promises.map((promise) => ({
        promise_id: promise.id,
        kind: promise.kind,
        /**
         * The capture status — whether Owed is tracking this read — and not the verdict.
         *
         * These are two different questions and this field answers the first: `Candidate`
         * below `TRACKING_CONFIDENCE`, `Captured` at or above it. Reporting the projected
         * status here instead briefly turned a `Captured` promise into `Suspected` as soon
         * as assessment began running, which reads like the endpoint changed its mind about
         * the extraction. What the engine made of it goes in `verdict`.
         */
        status: promise.status,
        confidence: promise.confidence,
        promised_in: promise.source_quote,
        /** `null` until something is decidable, rather than absent. */
        verdict: judged.promises.get(promise.id)?.assessment?.verdict ?? null,
      })),
    });
  });

  /**
   * Record something the home saw.
   *
   * The counterpart to `/control/messages`, and the half that was missing. A merchant
   * message could arrive at runtime and a doorbell event could not, so a live promise had
   * nothing to be judged against even once something was willing to judge it: of the
   * control routes, `auth`, `clock`, `commitments`, `messages` and `recourse` all existed
   * and evidence had none. The seeded week was the only data the breach engine ever saw.
   *
   * Validated through the domain schemas rather than by hand, so a malformed item is a 400
   * here instead of a projection that silently drops it — `projections.ts` discards evidence
   * with no `promise_id`, which would have made a typo look like a successful post.
   *
   * Same seam and same justification as the clock control: a property of the simulated home,
   * not of the add-on contract, so it stays outside the MCP surface.
   */
  app.post("/control/evidence", async (req: Request, res: Response) => {
    const body = req.body as Partial<Record<"evidence" | "uptime", unknown>>;
    const items = Array.isArray(body?.evidence) ? body.evidence : [];
    const windows = Array.isArray(body?.uptime) ? body.uptime : [];
    if (items.length === 0 && windows.length === 0) {
      res
        .status(400)
        .json({ error: "expected { evidence?: Evidence[], uptime?: ObservationWindow[] }" });
      return;
    }

    const evidence: Evidence[] = [];
    const uptime: ObservationWindow[] = [];
    try {
      for (const item of items) evidence.push(EvidenceSchema.parse(item));
      for (const window of windows) uptime.push(ObservationWindowSchema.parse(window));
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
      return;
    }

    const now = deps.clock.now();
    const appended = await deps.store.append([
      ...uptime.map((window) => ({
        id: deps.idGen.next("evt"),
        household_id: deps.householdId,
        occurred_at: window.interval.start,
        recorded_at: now,
        type: "SourceUptimeRecorded" as const,
        window,
      })),
      ...evidence.map((item) => ({
        id: deps.idGen.next("evt"),
        household_id: deps.householdId,
        occurred_at: item.captured_at,
        recorded_at: now,
        type: "EvidenceObserved" as const,
        evidence: item,
      })),
    ]);

    const assessed = await assessWhatIsPending(deps, now, appended[0]?.seq);
    const state = project(await deps.store.read(deps.householdId, now));

    res.json({
      now,
      recorded: { evidence: evidence.length, uptime: uptime.length },
      assessed,
      verdicts: [...state.promises.values()]
        .filter((view) => view.assessment !== undefined)
        .map((view) => ({
          promise_id: view.promise.id,
          kind: view.promise.kind,
          verdict: view.assessment?.verdict,
          breach: view.assessment?.kind,
          coverage: view.assessment?.coverage,
        })),
    });
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
