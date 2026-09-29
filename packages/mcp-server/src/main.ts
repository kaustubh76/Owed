import { FixedClock, MemoryEventStore, SeededIdGen, SystemClock } from "@owed/core";
import { createOwedApp } from "./app.js";
import { defaultAuthConfig } from "./auth/config.js";
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

const PORT = Number(process.env.OWED_PORT ?? 3939);
const BASE_URL = new URL(process.env.OWED_BASE_URL ?? `http://127.0.0.1:${PORT}`);

/**
 * A fixed development secret keeps tokens valid across restarts, so re-linking is not
 * part of every demo run. A deployment would supply its own.
 */
const AUTH_SECRET = process.env.OWED_AUTH_SECRET ?? "owed-development-secret-not-for-deployment";

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
 * than one that drifts. `OWED_DB=owed.db` puts it on disk instead, and then the seed is
 * written **only if the file is empty** — reseeding a ledger that already has a week in
 * it would append a second copy of everything, which is precisely the kind of quiet
 * corruption an append-only store exists to make impossible.
 */
const dbPath = process.env.OWED_DB;
const store = dbPath === undefined ? new MemoryEventStore() : new SqliteEventStore(dbPath);

const existing = await store.read(HOUSEHOLD_ID);
if (existing.length === 0) {
  await store.append(await storyboardEvents(idGen));
} else {
  process.stdout.write(
    `Owed ledger: ${existing.length} events already in ${dbPath}, not reseeding\n`,
  );
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

createOwedApp({
  deps,
  auth: { config: defaultAuthConfig(BASE_URL, AUTH_SECRET) },
  scrubbableClock: clock,
  scrubberRange: { start: STORYBOARD_START, end: STORYBOARD_END },
  recourseLog,
}).listen(PORT, "127.0.0.1", () => {
  process.stdout.write(
    `Owed MCP server on ${BASE_URL.origin}/mcp (now: ${clock.now()}, account linking on, ledger ${dbPath ?? "in memory"})\n`,
  );
  process.stdout.write(
    `  merchants: ${merchantsUrl === undefined ? "in-process" : merchantsUrl}\n`,
  );
});
