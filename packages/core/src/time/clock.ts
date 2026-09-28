import type { Instant } from "@owed/domain";

/**
 * The single seam through which ambient time is read.
 *
 * Nothing else in the codebase may call `Date.now()` or `new Date()` with no
 * argument — that ban is what makes the timeline scrubber, the golden storyboard
 * test and the eval matrix all reproducible (plan §6.3).
 */
export interface Clock {
  now(): Instant;
}

/** Wall-clock time. Used in production paths only. */
export class SystemClock implements Clock {
  now(): Instant {
    return new Date().toISOString();
  }
}

/** Scenario time. Used by the scrubber, the tests and the demo. */
export class FixedClock implements Clock {
  #current: Instant;

  constructor(start: Instant) {
    this.#current = start;
  }

  now(): Instant {
    return this.#current;
  }

  set(instant: Instant): void {
    this.#current = instant;
  }
}
