import { SystemClock } from "@owed/core";
import { type CommitmentEvent, linkAccount } from "@owed/mcp-server";
import { type WebSocket, WebSocketServer } from "ws";
import { OwedBrain } from "./brain.js";
import type { BrainToHome, ClockMessage, HomeToBrain } from "./protocol.js";
import { connectSession } from "./session.js";

const MCP_URL = new URL(process.env.OWED_MCP_URL ?? "http://127.0.0.1:3939/mcp");
const CLIENT_ID = process.env.OWED_CLIENT_ID ?? "owed-simulated-home";
const CONTROL_URL = new URL("/control/clock", MCP_URL);
const RECOURSE_URL = new URL("/control/recourse", MCP_URL);
const COMMITMENTS_URL = new URL("/control/commitments", MCP_URL);
/** Fast enough to feel like an interruption, slow enough to stay out of the way. */
const PROACTIVE_POLL_MS = 1500;
const PORT = Number(process.env.OWED_BRAIN_PORT ?? 3940);

/** Wall time here is for inspector timestamps only — never for domain decisions. */
const wallClock = new SystemClock();
const sockets = new Set<WebSocket>();

function broadcast(message: BrainToHome): void {
  const payload = JSON.stringify(message);
  for (const socket of sockets) {
    if (socket.readyState === socket.OPEN) socket.send(payload);
  }
}

/**
 * Link, then connect.
 *
 * The brain walks the real authorization-code + PKCE flow against Owed's own
 * authorization server rather than being handed a token out of band, so the demo
 * exercises account linking the same way a host would. `OWED_BRAIN_TOKEN` skips it
 * when a token is already in hand.
 */
async function linkAndConnect(attempts = 40, delayMs = 500) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const accessToken =
        process.env.OWED_BRAIN_TOKEN ??
        (await linkAccount({ baseUrl: new URL("/", MCP_URL), clientId: CLIENT_ID })).accessToken;

      return await connectSession({
        url: MCP_URL,
        accessToken,
        onFrame: (direction, message) => {
          broadcast({ type: "frame", channel: "mcp", direction, at: wallClock.now(), message });
        },
      });
    } catch (error) {
      if (attempt >= attempts) throw error;
      process.stdout.write(`waiting for ${MCP_URL.href} (${attempt}/${attempts})\n`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

const client = await linkAndConnect();
const brain = new OwedBrain(client);

/** The clock and, with it, the span the scrubber may move within. */
async function readClock(): Promise<Omit<ClockMessage, "type"> | undefined> {
  const response = await fetch(CONTROL_URL);
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
  const response = await fetch(CONTROL_URL, {
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
    const response = await fetch(new URL(`?since=${recourseCursor}`, RECOURSE_URL));
    if (!response.ok) return;
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
  } catch {
    // The observation window is a nicety; losing it must never break a turn.
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

async function pollCommitments(): Promise<void> {
  try {
    const response = await fetch(COMMITMENTS_URL);
    if (!response.ok) return;
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
  } catch {
    // The proactive channel is a stand-in for one that does not exist. Losing it must
    // never break a turn.
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
  // promise breaks should announce it there and then.
  await pollCommitments();
}

const server = new WebSocketServer({ port: PORT, host: "127.0.0.1" });

server.on("connection", (socket) => {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));

  void readClock().then((clock) => {
    if (clock !== undefined)
      socket.send(JSON.stringify({ type: "clock", ...clock } satisfies BrainToHome));
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

setInterval(() => void pollCommitments(), PROACTIVE_POLL_MS).unref();

process.stdout.write(
  `Owed brain on ws://127.0.0.1:${PORT} (linked to ${MCP_URL.href} as ${CLIENT_ID})\n`,
);
