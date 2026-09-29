import { DatabaseSync } from "node:sqlite";
import type { EventStore } from "@owed/core";
import type { Instant, LedgerEvent, StoredLedgerEvent } from "@owed/domain";
import { LedgerEventSchema, toEpochMs } from "@owed/domain";

/**
 * The ledger, on disk.
 *
 * An adapter rather than part of the core: the port is `EventStore` in `@owed/core`,
 * which knows nothing about SQLite, and this is the shell that satisfies it. Uses Node's
 * built-in `node:sqlite`, so persistence costs the project no dependency at all.
 *
 * **Append-only, and the schema says so rather than the comments.** There is no UPDATE
 * and no DELETE anywhere in this file; `seq` is the insertion order and is the primary
 * key. A ledger you can quietly rewrite is not evidence, and a household being told what
 * a merchant owes them deserves a record that cannot be edited after the fact.
 */
export class SqliteEventStore implements EventStore {
  readonly #db: DatabaseSync;

  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    // WAL so a reader (a tool call) and the writer (a claim being filed) do not block
    // each other; foreign keys on for the usual reasons.
    this.#db.exec("PRAGMA journal_mode = WAL");
    this.#db.exec("PRAGMA foreign_keys = ON");
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        seq            INTEGER PRIMARY KEY,
        household_id   TEXT    NOT NULL,
        occurred_at_ms INTEGER NOT NULL,
        payload        TEXT    NOT NULL
      ) STRICT;

      -- Every read is "this household, up to this instant", which is what replaying the
      -- ledger to a point in the week actually is.
      CREATE INDEX IF NOT EXISTS events_by_household_time
        ON events (household_id, occurred_at_ms, seq);
    `);
  }

  // Both methods are `async` rather than returning a resolved promise, so a bad row or
  // a failed transaction rejects instead of throwing synchronously out of something the
  // interface says returns a promise. A caller awaiting this should never need a
  // try/catch around the call itself as well as around the await.
  async append(events: readonly LedgerEvent[]): Promise<StoredLedgerEvent[]> {
    if (events.length === 0) return [];

    const next = this.#db.prepare("SELECT COALESCE(MAX(seq) + 1, 0) AS next FROM events").get() as
      | { next: number }
      | undefined;
    const from = next?.next ?? 0;

    const insert = this.#db.prepare(
      "INSERT INTO events (seq, household_id, occurred_at_ms, payload) VALUES (?, ?, ?, ?)",
    );

    const stored = events.map((event, offset) => ({ ...event, seq: from + offset }));

    // One transaction: a claim writes several events and a reader must never see half
    // of a filing.
    this.#db.exec("BEGIN");
    try {
      for (const event of stored) {
        insert.run(
          event.seq,
          event.household_id,
          toEpochMs(event.occurred_at),
          JSON.stringify(event),
        );
      }
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }

    return stored;
  }

  async read(householdId: string, upTo?: Instant): Promise<StoredLedgerEvent[]> {
    const limit = upTo === undefined ? Number.MAX_SAFE_INTEGER : toEpochMs(upTo);
    const rows = this.#db
      .prepare(
        "SELECT payload FROM events WHERE household_id = ? AND occurred_at_ms <= ? ORDER BY seq",
      )
      .all(householdId, limit) as Array<{ payload: string }>;

    // Parsed on the way out, like every other boundary in this project. A row that no
    // longer matches the schema — an older write, a hand-edited file — is a loud failure
    // rather than a card quietly showing something impossible.
    return rows.map((row) => {
      const raw = JSON.parse(row.payload) as { seq?: unknown };
      const event = LedgerEventSchema.parse(raw);
      return { ...event, seq: Number(raw.seq) } as StoredLedgerEvent;
    });
  }

  close(): void {
    this.#db.close();
  }
}
