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

  /**
   * Raise a prefix's counter past an id that already exists.
   *
   * Needed because the counters start at zero on every boot, which is correct when the
   * ledger is seeded in the same process and wrong when it is not. A server that finds a
   * ledger already on disk — or in DynamoDB — does not reseed, so without this the next
   * claim it files is handed `clm_000001` again and collides with the seeded week.
   *
   * Ignores anything that is not one of our ids, so it can be pointed at arbitrary event
   * payloads without the caller knowing which fields carry one.
   */
  observe(value: string): void {
    const match = /^([a-z]+)_(\d{6})$/.exec(value);
    if (match === null) return;
    const [, prefix, digits] = match;
    if (prefix === undefined || digits === undefined) return;
    const seen = Number.parseInt(digits, 10);
    if (seen > (this.#counters.get(prefix) ?? 0)) this.#counters.set(prefix, seen);
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
