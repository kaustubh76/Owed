import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { MemoryEventStore, project } from "@owed/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { at, HOUSEHOLD_ID, storyboardEvents } from "../seed/storyboard.js";
import { DynamoEventStore, ensureDynamoTable } from "./dynamo.js";

/**
 * These run against DynamoDB Local, not against AWS — no account, no credentials, no
 * network beyond loopback:
 *
 *   docker run --rm -d -p 8000:8000 --name owed-ddb amazon/dynamodb-local
 *
 * and they **skip** when it is not there. The repo's promise is that a clean clone can
 * run `pnpm verify` green with nothing installed and nothing signed up for
 * (readme §12), and a test that needs Docker to pass would quietly take that away. So the
 * DynamoDB adapter is checked when it can be, and says it was skipped when it cannot.
 */
const ENDPOINT = process.env.OWED_DYNAMO_ENDPOINT ?? "http://127.0.0.1:8000";

/**
 * Whether skipping is allowed.
 *
 * The skip above is right on a laptop and dangerous in CI. A skip is silent, so a CI job
 * whose service container came up slowly would skip these tests and still go green —
 * reporting coverage of the adapter that holds the household's ledger while testing none of
 * it. That is worse than having no CI for it, because it looks like there is.
 *
 * `OWED_REQUIRE_DYNAMO=1` says "I expect DynamoDB to be here", and an unreachable endpoint
 * becomes a failure instead. CI sets it; nobody else needs to.
 */
const REQUIRED = process.env.OWED_REQUIRE_DYNAMO === "1";

/** Retried, because a service container can take a moment and one probe is a coin toss. */
async function reachable(attempts = REQUIRED ? 20 : 1): Promise<boolean> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await fetch(ENDPOINT, { signal: AbortSignal.timeout(1500) });
      return true;
    } catch {
      if (attempt >= attempts) return false;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

const available = await reachable();

if (REQUIRED && !available) {
  throw new Error(
    `OWED_REQUIRE_DYNAMO=1 but nothing answered at ${ENDPOINT}.\n` +
      "These tests were about to skip silently, which in CI would report coverage of the\n" +
      "DynamoDB adapter while testing none of it. Start it with:\n" +
      "  docker run --rm -d -p 8000:8000 amazon/dynamodb-local",
  );
}

function localClient(): DynamoDBClient {
  return new DynamoDBClient({
    endpoint: ENDPOINT,
    region: "local",
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
  });
}

let client: DynamoDBClient;
let table: string;

describe.skipIf(!available)("the ledger in DynamoDB", () => {
  beforeEach(async () => {
    client = localClient();
    // A table per test, so one test's events can never explain another's pass.
    table = `owed-test-${Math.random().toString(36).slice(2, 10)}`;
    await ensureDynamoTable(client, table);
  });

  afterEach(() => {
    client.destroy();
  });

  it("reads back exactly what the memory store would have", async () => {
    const events = await storyboardEvents();
    const instant = at("sun", "19:30");

    const memory = new MemoryEventStore();
    await memory.append(events);

    const dynamo = new DynamoEventStore(table, client);
    await dynamo.append(events);

    expect(await dynamo.read(HOUSEHOLD_ID, instant)).toEqual(
      await memory.read(HOUSEHOLD_ID, instant),
    );
  });

  /** The whole point of persisting it. */
  it("survives the process that wrote it", async () => {
    const events = await storyboardEvents();

    const first = new DynamoEventStore(table, client);
    await first.append(events);
    const before = await first.read(HOUSEHOLD_ID);

    const second = new DynamoEventStore(table, localClient());
    expect(await second.read(HOUSEHOLD_ID)).toEqual(before);
    second.close();
  });

  /**
   * Replaying to an instant is the scrubber, and it has to mean the same thing in
   * DynamoDB as it does in memory — a narrower read, not a different answer.
   */
  it("replays to any instant, and the projection agrees", async () => {
    const events = await storyboardEvents();
    const dynamo = new DynamoEventStore(table, client);
    const memory = new MemoryEventStore();
    await dynamo.append(events);
    await memory.append(events);

    for (const day of ["mon", "wed", "fri", "sun"] as const) {
      const instant = at(day, "19:30");
      const fromDynamo = project(await dynamo.read(HOUSEHOLD_ID, instant));
      const fromMemory = project(await memory.read(HOUSEHOLD_ID, instant));
      expect([...fromDynamo.promises.keys()]).toEqual([...fromMemory.promises.keys()]);
      expect([...fromDynamo.claims.keys()]).toEqual([...fromMemory.claims.keys()]);
    }
  });

  it("keeps households apart", async () => {
    const dynamo = new DynamoEventStore(table, client);
    await dynamo.append(await storyboardEvents());
    expect(await dynamo.read("hh_somebody_else")).toEqual([]);
  });

  it("numbers events in the order they were appended, across calls", async () => {
    const events = await storyboardEvents();
    const dynamo = new DynamoEventStore(table, client);

    await dynamo.append(events.slice(0, 5));
    await dynamo.append(events.slice(5));

    const all = await dynamo.read(HOUSEHOLD_ID);
    expect(all.map((event) => event.seq)).toEqual(all.map((_, index) => index));
  });

  /**
   * Append-only is a promise about the data, so it is checked against the data rather
   * than trusted to the code that writes it.
   */
  it("never rewrites an event that is already there", async () => {
    const events = await storyboardEvents();
    const dynamo = new DynamoEventStore(table, client);
    await dynamo.append(events);

    const before = await dynamo.read(HOUSEHOLD_ID);
    await dynamo.append(events.slice(0, 3));
    const after = await dynamo.read(HOUSEHOLD_ID);

    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.length).toBe(before.length + 3);
  });

  /**
   * The counter is what makes `seq` safe without a lock, so the thing worth testing is
   * two filings landing at once rather than one after the other.
   */
  it("hands concurrent appends disjoint sequence numbers", async () => {
    const events = (await storyboardEvents()).slice(0, 3);
    const dynamo = new DynamoEventStore(table, client);

    const batches = await Promise.all([
      dynamo.append(events),
      dynamo.append(events),
      dynamo.append(events),
    ]);

    const seqs = batches.flat().map((event) => event.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it("refuses to hand back a row that is no longer a valid event", async () => {
    const dynamo = new DynamoEventStore(table, client);
    await dynamo.append((await storyboardEvents()).slice(0, 2));

    // Reach past the store and corrupt one item, the way a stale write or a hand edit
    // would. Parsing on read is what turns that into a loud failure.
    const { DynamoDBDocumentClient, PutCommand } = await import("@aws-sdk/lib-dynamodb");
    const doc = DynamoDBDocumentClient.from(client);
    await doc.send(
      new PutCommand({
        TableName: table,
        Item: {
          household_id: HOUSEHOLD_ID,
          sk: "0".repeat(16),
          seq: 0,
          occurred_at_ms: 0,
          payload: '{"type":"NotAnEvent"}',
        },
      }),
    );

    await expect(dynamo.read(HOUSEHOLD_ID)).rejects.toThrow();
  });
});

describe.skipIf(available)("the ledger in DynamoDB", () => {
  it.skip(`skipped: no DynamoDB Local at ${ENDPOINT}`, () => {});
});
