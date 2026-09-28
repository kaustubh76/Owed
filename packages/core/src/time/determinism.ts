/** Identifier generation, injected so runs are reproducible. */
export interface IdGen {
  next(prefix: string): string;
}

/**
 * Counter-based ids, e.g. `prm_000003`.
 *
 * Deliberately readable rather than random: these show up in the protocol
 * inspector during the demo, and a judge can follow `clm_000001` across panes.
 */
export class SeededIdGen implements IdGen {
  readonly #counters = new Map<string, number>();

  next(prefix: string): string {
    const n = (this.#counters.get(prefix) ?? 0) + 1;
    this.#counters.set(prefix, n);
    return `${prefix}_${String(n).padStart(6, "0")}`;
  }

  reset(): void {
    this.#counters.clear();
  }
}

/** Randomness, injected so merchant-agent behaviour is reproducible. */
export interface Rng {
  next(): number;
}

/** mulberry32 — small, fast, and identical across runs for a given seed. */
export class SeededRng implements Rng {
  #state: number;

  constructor(seed: number) {
    this.#state = seed >>> 0;
  }

  next(): number {
    this.#state = (this.#state + 0x6d2b79f5) >>> 0;
    let t = this.#state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
}
