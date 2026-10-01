import { FixedClock, MemoryEventStore, SeededIdGen, SystemClock } from "@owed/core";
import { createOwedApp } from "./app.js";
import { defaultAuthConfig } from "./auth/config.js";
import { assertSecretFitsBaseUrl, DEVELOPMENT_AUTH_SECRET } from "./auth/guard.js";
import type { OwedDeps } from "./deps.js";
import { httpMerchants } from "./merchants/http.js";
import { inProcessMerchants } from "./merchants/inProcess.js";
import { RecourseLog } from "./merchants/log.js";
import {
  CURRENCY,
  HOUSEHOLD_ID,
  STORYBOARD_END,
  STORYBOARD_QUERY_AT,
  STORYBOARD_START,
  storyboardEvents,
} from "./seed/storyboard.js";
import { SqliteEventStore } from "./store/sqlite.js";

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/**
 * Say why the process is dying before it dies.
 *
 * Node already exits on an unhandled rejection; what it does not do is explain itself next
 * to the restart in `journalctl`. With `Restart=always` and `RestartSec=2`, a crash loop
 * previously looked like nothing at all — and systemd's default start limit then puts the
 * unit in `failed` and stops retrying, so "nothing at all" was also permanent.
 *
 * Still exits. Fail fast is right for a supervised process; failing fast *quietly* is not.
 */
process.on("unhandledRejection", (reason) => {
  process.stderr.write(`owed server: unhandled rejection: ${describeError(reason)}\n`);
  process.exit(1);
});
process.on("uncaughtException", (error) => {
  process.stderr.write(`owed server: uncaught exception: ${describeError(error)}\n`);
  process.exit(1);
});

const PORT = Number(process.env.OWED_PORT ?? 3939);
const BASE_URL = new URL(process.env.OWED_BASE_URL ?? `http://127.0.0.1:${PORT}`);

/**
 * A fixed development secret keeps tokens valid across restarts, so re-linking is not
 * part of every demo run. A deployment must supply its own, and `assertSecretFitsBaseUrl`
 * below refuses to start rather than trusting it to remember.
 */
const AUTH_SECRET = process.env.OWED_AUTH_SECRET ?? DEVELOPMENT_AUTH_SECRET;
assertSecretFitsBaseUrl(AUTH_SECRET, BASE_URL);

/**
 * Bearer token for `/control/*`, and the extra hostnames to trust in `Host`/`Origin`.
 *
 * Both unset locally, so `pnpm demo` is unchanged. A deployment sets both: the token
 * because those routes are otherwise unauthenticated, and the hosts because a reverse
 * proxy forwards the public `Host` into a validator that only knows loopback.
 */
const CONTROL_TOKEN = process.env.OWED_CONTROL_TOKEN;
// Split and filtered rather than passed through: an empty string would otherwise become a
// one-element list containing "", and any non-empty list replaces the loopback defaults.
const ALLOWED_HOSTS = (process.env.OWED_ALLOWED_HOSTS ?? "")
  .split(",")
  .map((host) => host.trim())
  .filter((host) => host !== "");

/**
 * The demo runs on scenario time: a `FixedClock` parked in the seeded week. The
 * scrubber moves it, and every tool answers truthfully for wherever it has been moved.
 * Token lifetimes deliberately do not use this clock.
 */
// One id generator for the seeded week and everything filed live after it, so ids
// continue rather than collide.
const idGen = new SeededIdGen();

/**
 * Where the ledger lives.
 *
 * In memory by default, because a demo that reseeds identically every run is worth more
 * than one that drifts. `OWED_DB=owed.db` puts it on disk instead, and
 * `OWED_DYNAMO_TABLE=owed-ledger` puts it in DynamoDB for a deployment. In every case the
 * seed is written **only if the store is empty** — reseeding a ledger that already has a
 * week in it would append a second copy of everything, which is precisely the kind of
 * quiet corruption an append-only store exists to make impossible.
 *
 * Two of them set at once is a mistake worth hearing about rather than a precedence rule
 * worth remembering: a server that silently ignored `OWED_DYNAMO_TABLE` because `OWED_DB`
 * was also in the environment would be writing the household's ledger somewhere nobody
 * meant. The AWS SDK is imported only on the branch that needs it, so the offline demo
 * neither loads it nor pays for it.
 */
const dbPath = process.env.OWED_DB;
const dynamoTable = process.env.OWED_DYNAMO_TABLE;
if (dbPath !== undefined && dynamoTable !== undefined) {
  throw new Error("Set OWED_DB or OWED_DYNAMO_TABLE, not both — the ledger has one home");
}

const store = await (async () => {
  if (dynamoTable !== undefined) {
    const { DynamoEventStore } = await import("./store/dynamo.js");
    return new DynamoEventStore(dynamoTable);
  }
  if (dbPath !== undefined) return new SqliteEventStore(dbPath);
  return new MemoryEventStore();
})();

/**
 * Worded to read after "in", so the boot banner and the not-reseeding notice can both use
 * it. A server that says "ledger in memory" while writing to DynamoDB is the kind of
 * quiet inaccuracy this project exists to avoid.
 */
const storeLabel =
  dynamoTable !== undefined ? `DynamoDB table ${dynamoTable}` : (dbPath ?? "memory");

/**
 * Read the ledger before seeding, retrying a transient failure.
 *
 * This is a module-level await, so a rejection here means the process exits before it ever
 * listens. Against an in-memory store that was impossible; against DynamoDB a cold IAM
 * role, a throttle or a momentary network fault all land here — and because systemd's
 * default start limit is five starts in ten seconds, a two-second `RestartSec` would burn
 * through the whole budget in a blip and leave the unit **failed**, needing a human.
 *
 * So: retry with backoff for about half a minute, which outlasts anything transient, and
 * only then give up.
 */
async function readWithRetry(attempts = 6): Promise<Awaited<ReturnType<typeof store.read>>> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await store.read(HOUSEHOLD_ID);
    } catch (error) {
      if (attempt >= attempts) throw error;
      const wait = Math.min(500 * 2 ** (attempt - 1), 8000);
      process.stderr.write(
        `Owed ledger: ${storeLabel} unreadable (${describeError(error)}), retrying in ${wait}ms (${attempt}/${attempts})\n`,
      );
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}

const existing = await readWithRetry();
if (existing.length === 0) {
  await store.append(await storyboardEvents(idGen));
} else {
  process.stdout.write(
    `Owed ledger: ${existing.length} events already in ${storeLabel}, not reseeding\n`,
  );
  // Catch the id generator up to the ledger it just found.
  //
  // Without this, the counters start at zero while the ledger already contains
  // `clm_000001` and friends, so the first claim filed after a restart is handed an id
  // that already exists — and the idempotency check then reads it back as "already
  // filed", so nothing happens and no card appears. That failure needs persistence to
  // show up at all, which is why it survived until the ledger moved to DynamoDB.
  for (const event of existing) observeIds(event, idGen);
}

/**
 * Feed every id-shaped string in a value to the generator.
 *
 * Walks the payload rather than naming fields, because `LedgerEvent` is a union of seven
 * shapes and the ids live at different depths in each. `observe` ignores anything that is
 * not one of our ids, so over-reaching here is free and under-reaching is a collision.
 */
function observeIds(value: unknown, gen: SeededIdGen): void {
  if (typeof value === "string") {
    gen.observe(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) observeIds(item, gen);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) observeIds(item, gen);
  }
}

const clock = new FixedClock(process.env.OWED_NOW ?? STORYBOARD_QUERY_AT);
/**
 * Where merchant agents are found, decided once.
 *
 * Deliberately not a per-call fallback: quietly answering from in-process agents when the
 * real ones are unreachable would turn the demo path into a mock without saying so.
 */
const merchantsUrl = process.env.OWED_MERCHANTS_URL;
const recourseLog = new RecourseLog(new SystemClock());
const merchants =
  merchantsUrl === undefined
    ? inProcessMerchants()
    : httpMerchants({ baseUrl: new URL(merchantsUrl), log: recourseLog });

const deps: OwedDeps = {
  store,
  clock,
  householdId: HOUSEHOLD_ID,
  currency: CURRENCY,
  idGen,
  merchants,
};

const http = createOwedApp({
  deps,
  auth: { config: defaultAuthConfig(BASE_URL, AUTH_SECRET) },
  scrubbableClock: clock,
  scrubberRange: { start: STORYBOARD_START, end: STORYBOARD_END },
  recourseLog,
  ...(CONTROL_TOKEN === undefined ? {} : { controlToken: CONTROL_TOKEN }),
  allowedHosts: ALLOWED_HOSTS,
  // Still loopback, and deliberately so even in a deployment: Caddy runs on the same box
  // and proxies to 127.0.0.1, so nothing needs to listen on a public interface.
}).listen(PORT, "127.0.0.1", () => {
  process.stdout.write(
    `Owed MCP server on ${BASE_URL.origin}/mcp (now: ${clock.now()}, account linking on, ledger in ${storeLabel})\n`,
  );
  process.stdout.write(
    `  merchants: ${merchantsUrl === undefined ? "in-process" : merchantsUrl}\n`,
  );
});

/**
 * Stop cleanly when systemd says to.
 *
 * Previously SIGTERM killed the process mid-request on every deploy, and the store was
 * never closed — `SqliteEventStore.close()` and `DynamoEventStore.close()` both exist and
 * were called only from tests. For SQLite that leaves a WAL that is never checkpointed and
 * grows across restarts.
 */
function shutdown(signal: string): void {
  process.stdout.write(`owed server: ${signal}, closing\n`);
  http.close(() => {
    if ("close" in store && typeof store.close === "function") store.close();
    process.exit(0);
  });
  // Do not hang forever on a connection that will not drain.
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
