/** Messages on the single WebSocket between the brain and the simulated home. */

import type { CommitmentEvent } from "@owed/mcp-server";

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
 * Three channels: `mcp` is this brain talking to the add-on, `recourse` is the add-on
 * talking to a merchant's agent, and `proactive` is the add-on speaking first. The
 * second is traffic the brain never sees itself — the server records it and hands it
 * over, so the pane stays a recording either way. The third is a channel Alexa+ does
 * not have, shown on the wire precisely so the shape of the request is legible.
 */
export interface FrameMessage {
  type: "frame";
  channel: "mcp" | "recourse" | "proactive";
  merchant?: string;
  direction: "out" | "in";
  at: string;
  message: unknown;
}

/**
 * Owed speaking first.
 *
 * Alexa+ has no channel for this, so the home is told plainly that it is simulated and
 * badges it as such. `event` is carried whole rather than flattened, because the point
 * of the beat is that a judge can read the shape Amazon would have to emit.
 */
export interface ProactiveMessage {
  type: "proactive";
  event: CommitmentEvent;
  /** What the device says. The announcement's own line, not a tool's. */
  reply: string;
  view?: { uri: string; html: string; result: unknown };
}

export interface ClockMessage {
  type: "clock";
  now: string;
  /** The span the scrubber may move within, published by the server. */
  start?: string;
  end?: string;
}

export interface ErrorMessage {
  type: "error";
  message: string;
}

/**
 * The state of the hop the home cannot see.
 *
 * The home's own socket to the brain says nothing about whether the brain can reach the
 * MCP server, and those are different questions with the same symptom. Reporting only the
 * first is what let a brain with an expired token sit behind a header reading "brain
 * connected" while every utterance failed.
 */
export interface SessionMessage {
  type: "session";
  status: "linking" | "live" | "lost";
  /** Why, when it is known. Shown to whoever is looking, not parsed. */
  detail?: string;
}

export type BrainToHome =
  | TurnMessage
  | ProactiveMessage
  | FrameMessage
  | ClockMessage
  | ErrorMessage
  | SessionMessage;
