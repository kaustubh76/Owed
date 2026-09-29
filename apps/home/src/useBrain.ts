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

export interface BrainState {
  connected: boolean;
  turn: Turn | null;
  frames: Frame[];
  now: string | null;
  range: ScenarioRange | null;
  speak: (text: string) => void;
  scrub: (instant: string) => void;
}

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

  useEffect(() => {
    const socket = new WebSocket(BRAIN_URL);
    socketRef.current = socket;

    socket.addEventListener("open", () => setConnected(true));
    socket.addEventListener("close", () => setConnected(false));
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as { type: string } & Record<string, unknown>;
      if (message.type === "frame") {
        frameSeq.current += 1;
        const frame = { ...(message as unknown as Frame), id: frameSeq.current };
        // Recourse frames are polled after the turn that caused them, so they arrive
        // late. Both channels carry the same wall clock, so sorting puts the exchange
        // back where it happened: the call, the argument, then the result.
        setFrames((previous) =>
          [...previous, frame]
            .sort((a, b) => (a.at === b.at ? a.id - b.id : a.at < b.at ? -1 : 1))
            .slice(-MAX_FRAMES),
        );
      } else if (message.type === "turn") {
        setTurn(message as unknown as Turn);
      } else if (message.type === "proactive") {
        const event = message.event as Announcement;
        // Rendered as a turn with no utterance, because that is exactly what it is.
        setTurn({
          utterance: "",
          reply: message.reply as string,
          trace: [],
          ...(message.view ? { view: message.view as ViewPayload } : {}),
          proactive: { kind: event.kind, urgency: event.urgency, expires_at: event.expires_at },
        });
      } else if (message.type === "clock") {
        setNow(message.now as string);
        if (typeof message.start === "string" && typeof message.end === "string") {
          setRange({ start: message.start, end: message.end });
        }
      }
    });

    return () => socket.close();
  }, []);

  const send = useCallback((payload: object) => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
  }, []);

  return {
    connected,
    turn,
    frames,
    now,
    range,
    speak: useCallback((text: string) => send({ type: "utterance", text }), [send]),
    scrub: useCallback((instant: string) => send({ type: "scrub", instant }), [send]),
  };
}
