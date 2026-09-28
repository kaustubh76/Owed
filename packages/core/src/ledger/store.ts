import type { Instant, LedgerEvent, StoredLedgerEvent } from "@owed/domain";
import { toEpochMs } from "@owed/domain";

/**
 * Append-only event log. No updates, no deletes (plan §6.4).
 *
 * `read` filters on `occurred_at` — scenario time — so replaying to any instant is
 * just a narrower read, which is exactly what the timeline scrubber does.
 */
export interface EventStore {
  append(events: readonly LedgerEvent[]): Promise<StoredLedgerEvent[]>;
  read(householdId: string, upTo?: Instant): Promise<StoredLedgerEvent[]>;
}

export class MemoryEventStore implements EventStore {
  #events: StoredLedgerEvent[] = [];

  append(events: readonly LedgerEvent[]): Promise<StoredLedgerEvent[]> {
    const stored = events.map((event, offset) => ({
      ...event,
      seq: this.#events.length + offset,
    }));
    this.#events.push(...stored);
    return Promise.resolve(stored);
  }

  read(householdId: string, upTo?: Instant): Promise<StoredLedgerEvent[]> {
    const limit = upTo === undefined ? undefined : toEpochMs(upTo);
    return Promise.resolve(
      this.#events.filter(
        (e) =>
          e.household_id === householdId &&
          (limit === undefined || toEpochMs(e.occurred_at) <= limit),
      ),
    );
  }

  /** Test helper: every event, ignoring household and time. */
  all(): readonly StoredLedgerEvent[] {
    return this.#events;
  }
}
