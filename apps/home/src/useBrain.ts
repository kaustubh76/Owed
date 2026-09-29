import { useCallback, useEffect, useRef, useState } from "react";

export interface Frame {
  /** Assigned on arrival so each row has a stable identity as the list grows. */
  id: number;
  /** `mcp` is the brain talking to the add-on; `recourse` is the add-on and a merchant. */
  channel: "mcp" | "recourse";
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

export interface Turn {
  utterance: string;
  reply: string;
  trace: Array<{ tool: string; ms: number; isError: boolean; resourceUri?: string }>;
  view?: ViewPayload;
}

export interface BrainState {
  connected: boolean;
  turn: Turn | null;
  frames: Frame[];
  now: string | null;
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
      } else if (message.type === "clock") {
        setNow(message.now as string);
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
    speak: useCallback((text: string) => send({ type: "utterance", text }), [send]),
    scrub: useCallback((instant: string) => send({ type: "scrub", instant }), [send]),
  };
}
