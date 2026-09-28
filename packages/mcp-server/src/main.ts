import { FixedClock, MemoryEventStore } from "@owed/core";
import { createOwedApp } from "./app.js";
import { defaultAuthConfig } from "./auth/config.js";
import type { OwedDeps } from "./deps.js";
import {
  CURRENCY,
  HOUSEHOLD_ID,
  STORYBOARD_QUERY_AT,
  storyboardEvents,
} from "./seed/storyboard.js";

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
const store = new MemoryEventStore();
await store.append(storyboardEvents());

const clock = new FixedClock(process.env.OWED_NOW ?? STORYBOARD_QUERY_AT);
const deps: OwedDeps = { store, clock, householdId: HOUSEHOLD_ID, currency: CURRENCY };

createOwedApp({
  deps,
  auth: { config: defaultAuthConfig(BASE_URL, AUTH_SECRET) },
  scrubbableClock: clock,
}).listen(PORT, "127.0.0.1", () => {
  process.stdout.write(
    `Owed MCP server on ${BASE_URL.origin}/mcp (now: ${clock.now()}, account linking on)\n`,
  );
});
