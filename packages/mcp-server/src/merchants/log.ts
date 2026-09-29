import type { Clock } from "@owed/core";

export interface RecourseFrame {
  seq: number;
  /** Wall clock, so the inspector can interleave these with its own frames. */
  at: string;
  merchant: string;
  direction: "out" | "in";
  message: unknown;
}

/**
 * Recourse traffic, kept so the protocol inspector can show it.
 *
 * The inspector taps the brain's transport, which never sees this: an exchange with a
 * merchant happens between the server and that merchant. Without somewhere to read it
 * from, the pane promising to show the wire would be showing a rendering of a result.
 *
 * Bounded, because it is an observation window and not a second ledger.
 */
export class RecourseLog {
  readonly #frames: RecourseFrame[] = [];
  readonly #limit: number;
  readonly #clock: Clock;
  #next = 0;

  constructor(clock: Clock, limit = 500) {
    this.#clock = clock;
    this.#limit = limit;
  }

  append(frame: Omit<RecourseFrame, "seq" | "at">): void {
    this.#frames.push({ ...frame, seq: this.#next, at: this.#clock.now() });
    this.#next += 1;
    if (this.#frames.length > this.#limit) this.#frames.shift();
  }

  /** Everything recorded after `seq`, and the cursor to ask from next time. */
  since(seq: number): { frames: RecourseFrame[]; next: number } {
    return { frames: this.#frames.filter((frame) => frame.seq >= seq), next: this.#next };
  }
}
