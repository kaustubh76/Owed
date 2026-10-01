import { useCallback, useEffect, useRef, useState } from "react";

export interface Frame {
  /** Assigned on arrival so each row has a stable identity as the list grows. */
  id: number;
  /**
   * `mcp` is the brain talking to the add-on, `recourse` is the add-on and a merchant,
   * and `proactive` is the add-on speaking first over a channel Alexa+ does not have.
   */
  channel: "mcp" | "recourse" | "proactive";
  merchant?: string;
  direction: "out" | "in";
  at: string;
  message: unknown;
}

export interface ViewPayload {
  uri: string;
  html: string;
  result: unknown;
}

/**
 * Owed speaking first, which Alexa+ cannot do.
 *
 * Carried on the turn rather than beside it because that is what it is: a turn nobody
 * started. The home badges it so a judge is never left guessing which part is real.
 */
export interface Announcement {
  kind: string;
  urgency: string;
  expires_at: string;
}

export interface Turn {
  utterance: string;
  reply: string;
  trace: Array<{ tool: string; ms: number; isError: boolean; resourceUri?: string }>;
  view?: ViewPayload;
  proactive?: Announcement;
}

/** The span of scenario time the scrubber may move within, published by the server. */
export interface ScenarioRange {
  start: string;
  end: string;
}

/**
 * Every message the brain can send, as a discriminated union.
 *
 * Declared rather than imported because the home has no workspace dependencies on purpose
 * — it is a browser bundle, and `@owed/brain` carries `ws` and the MCP server with it. The
 * cost of that separation is that this has to be kept in step with
 * `apps/brain/src/protocol.ts` by hand; the benefit of declaring it at all is that the
 * dispatcher below can be exhaustive, which is what the previous shape gave up.
 *
 * The old code did `JSON.parse(...) as { type: string } & Record<string, unknown>` and then
 * `if / else if` on `message.type`. That discards the union, so TypeScript could not know
 * that `{ type: "error" }` — a declared member the brain really sends, on every failed turn
 * — had no branch. It was silently dropped, which is why a dead session looked like a demo
 * that simply did not respond.
 */
export type BrainMessage =
  | ({ type: "frame" } & Omit<Frame, "id">)
  | { type: "turn"; utterance: string; reply: string; trace: Turn["trace"]; view?: ViewPayload }
  | { type: "proactive"; event: Announcement; reply: string; view?: ViewPayload }
  | { type: "clock"; now: string; start?: string; end?: string }
  | { type: "error"; message: string }
  | { type: "session"; status: SessionStatus; detail?: string };

/** The brain's own link to the add-on — a hop the home cannot otherwise see. */
export type SessionStatus = "linking" | "live" | "lost";

export interface BrainState {
  /** The home's socket to the brain. */
  connected: boolean;
  /** The brain's session with the add-on. Both must be good for anything to work. */
  session: SessionStatus;
  /** The last failure the brain reported, which used to be discarded. */
  error: string | null;
  turn: Turn | null;
  frames: Frame[];
  now: string | null;
  range: ScenarioRange | null;
  speak: (text: string) => void;
  scrub: (instant: string) => void;
}

/** Capped so a long outage does not turn into a tight reconnect loop. */
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 10_000;

const BRAIN_URL = import.meta.env.VITE_BRAIN_URL ?? "ws://127.0.0.1:3940";
const MAX_FRAMES = 200;

/** The home's only link to the outside world: one socket to the brain. */
export function useBrain(): BrainState {
  const socketRef = useRef<WebSocket | null>(null);
  const frameSeq = useRef(0);
  const [connected, setConnected] = useState(false);
  const [turn, setTurn] = useState<Turn | null>(null);
  const [frames, setFrames] = useState<Frame[]>([]);
  const [now, setNow] = useState<string | null>(null);
  const [range, setRange] = useState<ScenarioRange | null>(null);

  const [session, setSession] = useState<SessionStatus>("linking");
  const [error, setError] = useState<string | null>(null);

  /**
   * Apply one message from the brain.
   *
   * A `switch` over the union with a `never` guard on the default, which is the whole point:
   * adding a message type to `BrainMessage` without a branch here is now a **compile
   * error**, not a silence. The bug this replaces was exactly that silence — `type: "error"`
   * was declared, sent on every failed turn, and quietly discarded.
   */
  const apply = useCallback((message: BrainMessage) => {
    switch (message.type) {
      case "frame": {
        frameSeq.current += 1;
        const frame = { ...message, id: frameSeq.current } as Frame;
        // Recourse frames are polled after the turn that caused them, so they arrive
        // late. Both channels carry the same wall clock, so sorting puts the exchange
        // back where it happened: the call, the argument, then the result.
        setFrames((previous) =>
          [...previous, frame]
            .sort((a, b) => (a.at === b.at ? a.id - b.id : a.at < b.at ? -1 : 1))
            .slice(-MAX_FRAMES),
        );
        return;
      }
      case "turn": {
        setError(null);
        setTurn({
          utterance: message.utterance,
          reply: message.reply,
          trace: message.trace,
          ...(message.view ? { view: message.view } : {}),
        });
        return;
      }
      case "proactive": {
        setError(null);
        // Rendered as a turn with no utterance, because that is exactly what it is.
        setTurn({
          utterance: "",
          reply: message.reply,
          trace: [],
          ...(message.view ? { view: message.view } : {}),
          proactive: {
            kind: message.event.kind,
            urgency: message.event.urgency,
            expires_at: message.event.expires_at,
          },
        });
        return;
      }
      case "clock": {
        setNow(message.now);
        if (typeof message.start === "string" && typeof message.end === "string") {
          setRange({ start: message.start, end: message.end });
        }
        return;
      }
      case "error": {
        setError(message.message);
        return;
      }
      case "session": {
        setSession(message.status);
        if (message.status === "lost") setError(message.detail ?? "lost the add-on session");
        if (message.status === "live") setError(null);
        return;
      }
      default: {
        // Exhaustiveness guard. If this stops compiling, a message type was added to
        // `BrainMessage` without a case above — which is the bug this file is fixing.
        const unhandled: never = message;
        void unhandled;
      }
    }
  }, []);

  /**
   * One socket, replaced whenever it goes.
   *
   * The old effect opened a socket, set a boolean on `close`, and stopped. A brain restart
   * therefore left every open page dead until a human reloaded it — and the brain runs
   * under `Restart=always`, so restarts are expected rather than exceptional. For a demo
   * that has to survive a judging window unattended, a page that cannot heal itself is the
   * same as no demo.
   */
  useEffect(() => {
    let cancelled = false;
    let socket: WebSocket | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;

    const open = () => {
      if (cancelled) return;
      socket = new WebSocket(BRAIN_URL);
      socketRef.current = socket;

      socket.addEventListener("open", () => {
        failures = 0;
        setConnected(true);
      });

      socket.addEventListener("message", (event) => {
        // Guarded, because one malformed frame used to throw inside the listener and take
        // the rest of that dispatch with it.
        let message: BrainMessage;
        try {
          message = JSON.parse(String(event.data)) as BrainMessage;
        } catch {
          return;
        }
        apply(message);
      });

      // `error` fires before `close` and must be observed, or the browser logs an
      // unhandled event. Reconnection is driven from `close`, which always follows.
      socket.addEventListener("error", () => setConnected(false));

      socket.addEventListener("close", () => {
        setConnected(false);
        if (cancelled) return;
        failures += 1;
        const delay = Math.min(RECONNECT_BASE_MS * 2 ** (failures - 1), RECONNECT_MAX_MS);
        retry = setTimeout(open, delay);
      });
    };

    open();

    return () => {
      cancelled = true;
      if (retry !== undefined) clearTimeout(retry);
      socket?.close();
    };
  }, [apply]);

  const send = useCallback((payload: object) => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
  }, []);

  return {
    connected,
    session,
    error,
    turn,
    frames,
    now,
    range,
    speak: useCallback((text: string) => send({ type: "utterance", text }), [send]),
    scrub: useCallback((instant: string) => send({ type: "scrub", instant }), [send]),
  };
}
