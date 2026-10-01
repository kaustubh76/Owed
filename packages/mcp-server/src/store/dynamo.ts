import {
  CreateTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  ResourceInUseException,
} from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type { EventStore } from "@owed/core";
import type { Instant, LedgerEvent, StoredLedgerEvent } from "@owed/domain";
import { LedgerEventSchema, toEpochMs } from "@owed/domain";

/**
 * The ledger, in DynamoDB.
 *
 * The third adapter behind the same port. `EventStore` in `@owed/core` knows nothing
 * about DynamoDB any more than it knows about SQLite, so the only thing this file has to
 * earn is identical observable behaviour — same events out, in the same order, for the
 * same arguments. `dynamo.test.ts` checks that by asserting against `MemoryEventStore`
 * for the same calls, which is how `sqlite.test.ts` earns the same claim.
 *
 * **Append-only, enforced by the write rather than by convention.** Every put carries
 * `attribute_not_exists(sk)`, so re-using a sequence number fails the transaction instead
 * of silently overwriting a record. A ledger you can quietly rewrite is not evidence.
 *
 * Key design:
 *
 *   pk  household_id
 *   sk  the sequence number, zero-padded so lexicographic order is numeric order
 *
 * Sorting on `seq` rather than on time is deliberate and not the obvious choice. Reads
 * are always "this household, up to this instant", so time looks like the natural sort
 * key — but both other adapters return insertion order (`ORDER BY seq` in SQLite, array
 * order in memory), and an adapter that reordered events for the same query would be a
 * different store wearing the same interface. Time is therefore a filter, not a key.
 *
 * The cost of that choice is honest: a `read` with `upTo` set pays to read the events it
 * then discards, because DynamoDB applies `FilterExpression` after the key condition. A
 * household ledger is tens to hundreds of events, so this is cheaper than the extra index
 * that would avoid it, and far cheaper than a second sort order to keep consistent.
 */
export class DynamoEventStore implements EventStore {
  readonly #doc: DynamoDBDocumentClient;
  readonly #table: string;
  readonly #ownsClient: boolean;

  /**
   * `client` is injectable so the tests can point at DynamoDB Local without the adapter
   * knowing anything about endpoints or credentials. Passed a client, it does not own it
   * and will not close it.
   */
  constructor(table: string, client?: DynamoDBClient) {
    this.#table = table;
    this.#ownsClient = client === undefined;
    this.#doc = DynamoDBDocumentClient.from(client ?? new DynamoDBClient(CLIENT_CONFIG), {
      marshallOptions: { removeUndefinedValues: true },
    });
  }

  async append(events: readonly LedgerEvent[]): Promise<StoredLedgerEvent[]> {
    if (events.length === 0) return [];

    // A claim writes several events and a reader must never see half of a filing, so the
    // puts go in one transaction. DynamoDB caps a transaction at 100 items; a filing
    // writes a handful, and failing loudly beats silently splitting one into two batches
    // that a reader could catch between.
    if (events.length > MAX_TRANSACTION_ITEMS) {
      throw new Error(
        `append() received ${events.length} events; DynamoDB transactions hold at most ${MAX_TRANSACTION_ITEMS}`,
      );
    }

    const from = await this.#reserveSequenceBlock(events.length);
    const stored = events.map((event, offset) => ({ ...event, seq: from + offset }));

    await this.#doc.send(
      new TransactWriteCommand({
        TransactItems: stored.map((event) => ({
          Put: {
            TableName: this.#table,
            Item: {
              household_id: event.household_id,
              sk: sortKey(event.seq),
              seq: event.seq,
              occurred_at_ms: toEpochMs(event.occurred_at),
              payload: JSON.stringify(event),
            },
            // Append-only: a sequence number is used once, and a collision is a bug worth
            // hearing about rather than a record worth losing.
            ConditionExpression: "attribute_not_exists(sk)",
          },
        })),
      }),
    );

    return stored;
  }

  async read(householdId: string, upTo?: Instant): Promise<StoredLedgerEvent[]> {
    const limit = upTo === undefined ? Number.MAX_SAFE_INTEGER : toEpochMs(upTo);
    const rows: Array<{ payload: string }> = [];

    // Paginated rather than assuming one page. A household that used this for a year
    // would quietly lose the tail of its own ledger otherwise, and the failure would look
    // like a card showing the wrong total rather than like an error.
    let startKey: Record<string, unknown> | undefined;
    do {
      const page = await this.#doc.send(
        new QueryCommand({
          TableName: this.#table,
          KeyConditionExpression: "household_id = :household",
          FilterExpression: "occurred_at_ms <= :limit",
          ExpressionAttributeValues: { ":household": householdId, ":limit": limit },
          // Ascending, which for this key design is sequence order.
          ScanIndexForward: true,
          ...(startKey === undefined ? {} : { ExclusiveStartKey: startKey }),
        }),
      );
      for (const item of page.Items ?? []) {
        rows.push(item as { payload: string });
      }
      startKey = page.LastEvaluatedKey;
    } while (startKey !== undefined);

    // Parsed on the way out, like every other boundary in this project. A row that no
    // longer matches the schema is a loud failure rather than a card quietly showing
    // something impossible.
    return rows.map((row) => {
      const raw = JSON.parse(row.payload) as { seq?: unknown };
      const event = LedgerEventSchema.parse(raw);
      return { ...event, seq: Number(raw.seq) } as StoredLedgerEvent;
    });
  }

  /**
   * Reserves `count` consecutive sequence numbers and returns the first.
   *
   * SQLite gets this from `MAX(seq) + 1` inside the same transaction as the insert.
   * DynamoDB has no equivalent, so the counter is its own item and `ADD` makes the
   * increment atomic — two concurrent filings get disjoint blocks without either taking
   * a lock.
   *
   * `seq` stays globally monotonic rather than per-household, matching the other two
   * adapters. Per-household counters would be the more natural DynamoDB shape and would
   * partition better, but it is a behaviour change to the ledger's ordering and belongs in
   * a decision of its own, not smuggled in under a storage swap.
   *
   * A reserved block whose transaction then fails leaves a gap. That is fine and worth
   * saying out loud: the ledger needs `seq` to be unique and increasing, never dense.
   */
  async #reserveSequenceBlock(count: number): Promise<number> {
    const result = await this.#doc.send(
      new UpdateCommand({
        TableName: this.#table,
        Key: { household_id: COUNTER_PK, sk: COUNTER_SK },
        UpdateExpression: "ADD #n :count",
        ExpressionAttributeNames: { "#n": "n" },
        ExpressionAttributeValues: { ":count": count },
        ReturnValues: "UPDATED_NEW",
      }),
    );

    const next = Number(result.Attributes?.n ?? count);
    // `ADD` returns the total after the increment; the block is the `count` numbers
    // ending there. Starting at 0 matches SQLite's `COALESCE(MAX(seq) + 1, 0)`.
    return next - count;
  }

  /** Mirrors `SqliteEventStore.close()`. A no-op when the client was passed in. */
  close(): void {
    if (this.#ownsClient) this.#doc.destroy();
  }
}

/**
 * The counter lives in the table it counts for, on a partition key no household can
 * collide with — `HouseholdIdSchema` does not admit a leading `#`. One table, so one
 * thing to provision and one thing to back up.
 */
/**
 * Explicit bounds, because the default is "wait".
 *
 * The client was previously constructed with `{}`, which takes the SDK's defaults — and a
 * `read` paginates, so an unresponsive endpoint could stall per page with no ceiling at
 * all. A household's tool call that hangs is worse than one that fails: the brain polls on
 * a 1500 ms timer, so stalled requests pile up behind each other and the whole surface goes
 * quiet rather than erroring.
 *
 * `maxAttempts` includes the first try. Three is enough to ride out a throttle without
 * turning one slow call into thirty seconds of silence; above that it is the caller's
 * problem to report, which it now does.
 */
const CLIENT_CONFIG = {
  maxAttempts: 3,
  requestHandler: { requestTimeout: 3000, connectionTimeout: 1500 },
} as const;

const COUNTER_PK = "#seq";
const COUNTER_SK = "#counter";

const MAX_TRANSACTION_ITEMS = 100;

/**
 * Zero-padded to the width of `Number.MAX_SAFE_INTEGER`, because DynamoDB sorts string
 * keys lexicographically and `"10"` sorts before `"9"`.
 */
const SEQ_WIDTH = 16;

function sortKey(seq: number): string {
  return String(seq).padStart(SEQ_WIDTH, "0");
}

/**
 * Creates the table if it is not already there.
 *
 * `SqliteEventStore` does this in its constructor, because for SQLite the schema and the
 * file are the same thing. Here they are not: the table is infrastructure, it outlives
 * any process, and creating it is a privilege a running server should not hold. So this
 * is a separate function that the tests and a local DynamoDB use, and the deployed server
 * does not call.
 *
 * In a deployment the table is created by hand, with the `aws dynamodb create-table` in
 * `deploy/README.md` — there is no CDK, and an earlier version of this comment claimed
 * there was. So this function's second job is to be the executable statement of what that
 * command has to produce: `dynamo.test.ts` builds its tables through here, and
 * `scripts/aws-smoke.mjs` asserts the real table's key schema matches.
 *
 * On-demand billing, because a household ledger's traffic is spiky and tiny, and a
 * provisioned floor would be the single largest line on the bill.
 */
export async function ensureDynamoTable(client: DynamoDBClient, table: string): Promise<void> {
  try {
    await client.send(
      new CreateTableCommand({
        TableName: table,
        BillingMode: "PAY_PER_REQUEST",
        KeySchema: [
          { AttributeName: "household_id", KeyType: "HASH" },
          { AttributeName: "sk", KeyType: "RANGE" },
        ],
        AttributeDefinitions: [
          { AttributeName: "household_id", AttributeType: "S" },
          { AttributeName: "sk", AttributeType: "S" },
        ],
      }),
    );
  } catch (error) {
    // Already there is the expected case on every boot after the first.
    if (!(error instanceof ResourceInUseException)) throw error;
  }

  await client.send(new DescribeTableCommand({ TableName: table }));
}
