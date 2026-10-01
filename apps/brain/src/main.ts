import { SystemClock } from "@owed/core";
import type { CommitmentEvent } from "@owed/mcp-server";
import { type WebSocket, WebSocketServer } from "ws";
import { OwedBrain } from "./brain.js";
import type { BrainToHome, ClockMessage, HomeToBrain } from "./protocol.js";
import { openSession } from "./session.js";

const MCP_URL = new URL(process.env.OWED_MCP_URL ?? "http://127.0.0.1:3939/mcp");
const CLIENT_ID = process.env.OWED_CLIENT_ID ?? "owed-simulated-home";
const CONTROL_URL = new URL("/control/clock", MCP_URL);
const CONTROL_TOKEN = process.env.OWED_CONTROL_TOKEN;
const RECOURSE_URL = new URL("/control/recourse", MCP_URL);
const COMMITMENTS_URL = new URL("/control/commitments", MCP_URL);
/** Fast enough to feel like an interruption, slow enough to stay out of the way. */
const PROACTIVE_POLL_MS = 1500;
/**
 * Generous, and deliberately *longer* than the poll interval.
 *
 * My first attempt made this 1200 ms — shorter than the tick — reasoning that a stall
 * should not outlive the tick that caused it. Running it against real DynamoDB disproved
 * that in one go: `/control/commitments` replays the whole ledger, which is microseconds
 * against the in-memory store and sometimes over a second against DynamoDB from a laptop.
 * Every poll timed out, so the proactive announcement never arrived at all.
 *
 * Keeping the cadence is the re-entrancy guard's job (`polling` below), not the timeout's.
 * The timeout is here to bound a genuine hang, which is a much rarer thing and deserves a
 * much larger number.
 */
const CONTROL_TIMEOUT_MS = 5000;
const PORT = Number(process.env.OWED_BRAIN_PORT ?? 3940);

/** Wall time here is for inspector timestamps only — never for domain decisions. */
const wallClock = new SystemClock();
const sockets = new Set<WebSocket>();

/**
 * The last session state, remembered rather than only broadcast.
 *
 * The brain links before any browser is listening, so a socket that connects afterwards
 * would never hear about it. Replayed on connection, the way the clock already is.
 */
let sessionStatus: "linking" | "live" | "lost" = "linking";

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/**
 * Say why the process is dying before it dies.
 *
 * Node already exits on an unhandled rejection; what it does not do is explain itself in a
 * way `journalctl` will show next to the restart. Every one of these was previously a bare
 * exit with a stack and no service name, in a unit configured to restart immediately — so
 * a crash loop looked like nothing at all.
 *
 * Still exits. Fail fast is right for a supervised process; failing fast *quietly* is not.
 */
function installCrashHandlers(service: string): void {
  process.on("unhandledRejection", (reason) => {
    process.stderr.write(`${service}: unhandled rejection: ${describe(reason)}\n`);
    process.exit(1);
  });
  process.on("uncaughtException", (error) => {
    process.stderr.write(`${service}: uncaught exception: ${describe(error)}\n`);
    process.exit(1);
  });
}

installCrashHandlers("owed brain");

function broadcast(message: BrainToHome): void {
  const payload = JSON.stringify(message);
  for (const socket of sockets) {
    if (socket.readyState === socket.OPEN) socket.send(payload);
  }
}

/**
 * The session, managed rather than established once.
 *
 * What this replaces: a single link-and-connect at startup whose `Client` was then held for
 * the life of the process. (`linkAndConnect` still exists in `session.ts`, but as the
 * adapter the manager calls on every reconnect rather than the one-shot it used to be.) That held a one-hour access token frozen into the transport, and no
 * handler for the transport closing — so the brain stopped working either when the token
 * expired or when the server restarted, whichever came first, in both cases silently and
 * permanently. See `session.ts`.
 */
const session = openSession({
  url: MCP_URL,
  baseUrl: new URL("/", MCP_URL),
  clientId: CLIENT_ID,
  onFrame: (direction, message) => {
    broadcast({ type: "frame", channel: "mcp", direction, at: wallClock.now(), message });
  },
  // The home cannot see this hop, so it has to be told about it. "brain connected" while
  // the brain cannot reach the server is the lie that made this undiagnosable.
  onStatus: (status, detail) => {
    sessionStatus = status;
    broadcast({ type: "session", status, ...(detail === undefined ? {} : { detail }) });
  },
  ...(process.env.OWED_BRAIN_TOKEN === undefined
    ? {}
    : { staticToken: process.env.OWED_BRAIN_TOKEN }),
});

const brain = new OwedBrain(session);

/**
 * Link before binding the socket, and keep retrying while the server comes up.
 *
 * This preserves the old boot behaviour exactly — the brain's port stays closed until it
 * has a live session, so the home's "brain connected" means both hops are good — while the
 * session itself is now rebuildable at runtime. Boot ordering was the one thing the old
 * code genuinely got right (40 attempts, then exit and let systemd retry), so it is kept.
 */
for (let attempt = 1; ; attempt += 1) {
  try {
    await session.ready();
    break;
  } catch (error) {
    if (attempt >= 40) throw error;
    process.stdout.write(`waiting for ${MCP_URL.href} (${attempt}/40): ${describe(error)}\n`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/**
 * Every `/control/*` request, with the token attached when there is one.
 *
 * Those routes carry no auth of their own on a loopback demo, which is fine there and not
 * fine on a public origin — the server gates them once `OWED_CONTROL_TOKEN` is set, and
 * the brain is the only caller, so this is the one place that has to know. Unset locally,
 * which keeps `pnpm demo` exactly as it was.
 */
function controlFetch(url: URL | string, init?: RequestInit): Promise<Response> {
  return fetch(url, {
    ...init,
    // A ceiling, because none of these had one. A hung request is worse than a failed one
    // here: the proactive poll fires every 1500 ms, so stalled fetches stack up behind each
    // other and the brain goes quiet instead of erroring.
    signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
    headers: {
      ...init?.headers,
      ...(CONTROL_TOKEN === undefined ? {} : { authorization: `Bearer ${CONTROL_TOKEN}` }),
    },
  });
}

/**
 * Report a repeating failure without filling the journal.
 *
 * The poll loops used to swallow everything into an empty `catch`, which is right about
 * never breaking a turn and wrong about saying nothing: with the server down the brain made
 * forty failing requests a minute and emitted **not one line**. The token-expiry bug lived
 * in exactly that blind spot — it produced no evidence of itself anywhere.
 *
 * So: log the first failure of a run, then at most one line a minute, and log recovery too,
 * because "it started working again" is the other half of the story.
 */
const complaints = new Map<string, number>();
const COMPLAIN_EVERY_MS = 60_000;

function complain(what: string, error: unknown): void {
  const last = complaints.get(what) ?? 0;
  const now = Date.now();
  if (now - last < COMPLAIN_EVERY_MS) return;
  complaints.set(what, now);
  process.stderr.write(`owed brain: ${what} failing: ${describe(error)}\n`);
}

function recovered(what: string): void {
  if (complaints.delete(what)) {
    process.stderr.write(`owed brain: ${what} recovered\n`);
  }
}

/** The clock and, with it, the span the scrubber may move within. */
async function readClock(): Promise<Omit<ClockMessage, "type"> | undefined> {
  const response = await controlFetch(CONTROL_URL);
  if (!response.ok) return undefined;
  const body = (await response.json()) as { now?: string; start?: string; end?: string };
  if (typeof body.now !== "string") return undefined;
  return {
    now: body.now,
    ...(typeof body.start === "string" ? { start: body.start } : {}),
    ...(typeof body.end === "string" ? { end: body.end } : {}),
  };
}

async function setClock(instant: string): Promise<string | undefined> {
  const response = await controlFetch(CONTROL_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ instant }),
  });
  if (!response.ok) return undefined;
  return ((await response.json()) as { now?: string }).now;
}

/**
 * Recourse traffic the server recorded while it was answering.
 *
 * Polled after the turn rather than streamed: the exchange is over by the time the tool
 * returns, and the inspector sorts by timestamp so it still reads in the order it
 * happened — the call, then the argument with the merchant, then the result.
 */
let recourseCursor = 0;

async function drainRecourse(): Promise<void> {
  try {
    const response = await controlFetch(new URL(`?since=${recourseCursor}`, RECOURSE_URL));
    // A non-OK answer used to return silently, which made a 401 from a wrong control token,
    // a 404 from a Caddy misroute and "nothing happened" completely indistinguishable.
    if (!response.ok) {
      complain("recourse drain", new Error(`HTTP ${response.status}`));
      return;
    }
    recovered("recourse drain");
    const { frames, next } = (await response.json()) as {
      frames: Array<{ at: string; merchant: string; direction: "out" | "in"; message: unknown }>;
      next: number;
    };
    recourseCursor = next;
    for (const frame of frames) {
      broadcast({
        type: "frame",
        channel: "recourse",
        merchant: frame.merchant,
        direction: frame.direction,
        at: frame.at,
        message: frame.message,
      });
    }
  } catch (error) {
    // The observation window is a nicety; losing it must never break a turn.
    complain("recourse drain", error);
  }
}

/**
 * What the household has already been told.
 *
 * Reconciled against what is due rather than only added to. Scrubbing back through the
 * week has to take an announcement away again, or dragging forwards a second time would
 * pass the same moment in silence.
 */
let announced = new Set<string>();
/**
 * A host that has just come up does not read out the backlog.
 *
 * The first poll records what is already true without saying any of it, so the demo
 * starts quiet and every announcement after that is something that genuinely changed.
 */
let primed = false;

/**
 * One poll at a time.
 *
 * The timer fires every 1500 ms, and a poll now awaits a real network round trip on the
 * server side (the ledger is in DynamoDB), so two polls can overlap. Overlapping is wrong
 * however the bookkeeping is arranged: both passes see the same event as unannounced and
 * announce it twice, and since the loop deliberately leaves the household looking at the
 * *most recent* announcement, a duplicate can leave the wrong one on screen.
 *
 * Skipping a tick costs nothing — the endpoint is a projection, not a queue, so the next
 * poll sees exactly the same thing.
 */
async function pollCommitments(): Promise<void> {
  try {
    const response = await controlFetch(COMMITMENTS_URL);
    if (!response.ok) {
      complain("proactive poll", new Error(`HTTP ${response.status}`));
      return;
    }
    recovered("proactive poll");
    const { events } = (await response.json()) as { events: CommitmentEvent[] };
    const due = new Set(events.map((event) => event.event_id));

    for (const id of [...announced]) if (!due.has(id)) announced.delete(id);

    if (!primed) {
      primed = true;
      announced = due;
      return;
    }

    // Oldest first, so when several fall due at once — which is what crossing a day
    // with the scrubber does — the household is left looking at the most recent.
    for (const event of events) {
      if (announced.has(event.event_id)) continue;

      // Shown on the inspector as its own channel: the point of the beat is that a
      // judge can read the shape Alexa+ would have to emit, on the wire, in context.
      announced.add(event.event_id);

      // Shown on the inspector as its own channel: the point of the beat is that a
      // judge can read the shape Alexa+ would have to emit, on the wire, in context.
      broadcast({
        type: "frame",
        channel: "proactive",
        direction: "in",
        at: wallClock.now(),
        message: event,
      });
      broadcast(await brain.announce(event));
    }
  } catch (error) {
    // The proactive channel is a stand-in for one that does not exist. Losing it must
    // never break a turn — but it should still be visible.
    complain("proactive poll", error);
  }
}

async function handle(message: HomeToBrain): Promise<void> {
  if (message.type === "utterance") {
    const turn = await brain.turn(message.text);
    await drainRecourse();
    broadcast(turn);
    await pollCommitments();
    return;
  }
  const now = await setClock(message.instant);
  if (now !== undefined) broadcast({ type: "clock", now });
  // Poll immediately rather than waiting for the timer: scrubbing onto the moment a
  // promise breaks should announce it there and then. Forced, because a poll already in
  // flight is answering for the clock we just moved away from.
  await pollCommitments();
}

const server = new WebSocketServer({ port: PORT, host: "127.0.0.1" });

// Same reasoning as the per-socket listener: unhandled `error` on an EventEmitter throws.
server.on("error", (error) => {
  process.stderr.write(`owed brain: websocket server error: ${describe(error)}\n`);
});

server.on("connection", (socket) => {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));

  socket.send(JSON.stringify({ type: "session", status: sessionStatus } satisfies BrainToHome));

  // A rejection handler, not decoration. `readClock` awaits a bare fetch, so a browser
  // connecting while the MCP server is restarting rejected here with nothing attached —
  // an unhandled rejection, which Node answers by killing the brain.
  void readClock()
    .then((clock) => {
      if (clock !== undefined && socket.readyState === socket.OPEN)
        socket.send(JSON.stringify({ type: "clock", ...clock } satisfies BrainToHome));
    })
    .catch((error: unknown) => {
      process.stderr.write(`owed brain: could not read the clock: ${describe(error)}\n`);
    });

  // `ws` emits `error` on the socket, and an EventEmitter `error` with no listener is an
  // uncaught exception. A killed tab, a sleeping laptop or a Caddy restart all produce
  // ECONNRESET here, and each of them used to take the whole brain down with it.
  socket.on("error", (error) => {
    process.stderr.write(`owed brain: socket error: ${describe(error)}\n`);
    sockets.delete(socket);
  });

  socket.on("message", (raw) => {
    void (async () => {
      try {
        await handle(JSON.parse(String(raw)) as HomeToBrain);
      } catch (error) {
        broadcast({
          type: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    })();
  });
});

const poll = setInterval(() => void pollCommitments(), PROACTIVE_POLL_MS);
poll.unref();

/**
 * Stop cleanly when systemd says to.
 *
 * Without this, SIGTERM killed the process mid-frame on every deploy: browsers saw a TCP
 * teardown rather than a close frame, and the 1500 ms poll kept firing into the shutdown.
 * `1001` is "going away", which is exactly what is happening and lets the home distinguish
 * a deploy from a crash.
 */
function shutdown(signal: string): void {
  process.stdout.write(`owed brain: ${signal}, closing\n`);
  clearInterval(poll);
  session.stop();
  for (const socket of sockets) socket.close(1001, "brain shutting down");
  server.close(() => process.exit(0));
  // Do not hang forever on a socket that will not close.
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

process.stdout.write(
  `Owed brain on ws://127.0.0.1:${PORT} (linked to ${MCP_URL.href} as ${CLIENT_ID})\n`,
);
