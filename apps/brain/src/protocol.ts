/** Messages on the single WebSocket between the brain and the simulated home. */

export interface UtteranceMessage {
  type: "utterance";
  text: string;
}

export interface ScrubMessage {
  type: "scrub";
  instant: string;
}

export type HomeToBrain = UtteranceMessage | ScrubMessage;

export interface ToolTrace {
  tool: string;
  args: Record<string, unknown>;
  ms: number;
  isError: boolean;
  resourceUri?: string;
}

export interface TurnMessage {
  type: "turn";
  utterance: string;
  /** What the device says out loud. Always sufficient on its own. */
  reply: string;
  trace: ToolTrace[];
  view?: { uri: string; html: string; result: unknown };
}

/**
 * A real JSON-RPC frame, captured on the wire for the protocol inspector.
 *
 * Two channels: `mcp` is this brain talking to the add-on, `recourse` is the add-on
 * talking to a merchant's agent. The second is traffic the brain never sees itself — the
 * server records it and hands it over, so the pane stays a recording either way.
 */
export interface FrameMessage {
  type: "frame";
  channel: "mcp" | "recourse";
  merchant?: string;
  direction: "out" | "in";
  at: string;
  message: unknown;
}

export interface ClockMessage {
  type: "clock";
  now: string;
}

export interface ErrorMessage {
  type: "error";
  message: string;
}

export type BrainToHome = TurnMessage | FrameMessage | ClockMessage | ErrorMessage;
