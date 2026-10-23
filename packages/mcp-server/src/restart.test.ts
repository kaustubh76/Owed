import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { project } from "@owed/core";
import type { StoredLedgerEvent } from "@owed/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HOUSEHOLD_ID } from "./seed/storyboard.js";
import { SqliteEventStore } from "./store/sqlite.js";

/**
 * The ledger on disk, across a restart — driven as a process, because that is the only place
 * this code runs.
 *
 * `OWED_DB=owed.db` is the one configuration a presenter reaches for and nothing exercised.
 * `main.ts` decides three things at boot, all of it top-level code that executes on import:
 * seed when the store is empty, say "not reseeding" when it is not, and catch the id counters
 * up to the ledger it just found. `store/sqlite.test.ts` covers the adapter thoroughly and
 * never boots the server; `scripts/capture-demo.mjs` deliberately unsets `OWED_DB`;
 * `apps/brain/src/boot.test.ts` spawns the *brain*. Nothing had ever run this.
 *
 * Two failures it stands between, both of which would show up on camera:
 *
 *  - **A second seed doubles the week.** Restart with the file still there and the household has
 *    recovered ninety-four dollars.
 *  - **An id collision re-mints an id the week already used.** `idGen` is counter-based and
 *    shared with the seed, and which ids that covers is worth being exact about, because the
 *    obvious guess is wrong. The seed writes **promise and claim ids as short literals** —
 *    `prm_001`, `clm_007` — while the generator pads to six (`prm_000001`), so those two can
 *    never collide. What the seed *does* take from the counter is the ids it does not need to be
 *    readable: `evt_000001`-`evt_000081`, `brc_000001`-`brc_000011` and `evd_000001` upward. Every
 *    one of those is minted again by a live capture, so without the catch-up the next event
 *    written is `evt_000001` a second time. `app.ts` asserts the invariant in a comment —
 *    "`deps.idGen` is shared with the seed and counter-based, so ids stay unique" — and nothing
 *    held it. An earlier draft of this test asserted *promise* ids and passed with the catch-up
 *    deleted, which is how the literals came to light.
 *
 * `SeededIdGen.observe` is unit-tested in `core`'s `determinism.test.ts`. `observeIds` — the
 * recursive walker in `main.ts` that feeds it every id in the ledger — has no caller in any test,
 * and cannot have one that is not a subprocess.
 */

const MAIN = fileURLToPath(new URL("../dist/main.js", import.meta.url));

/** One boot, including Node starting and the MCP SDK and Express loading. */
const BOOT_MS = 20_000;

/** What happens around the two boots: the HTTP round trip, two SIGTERMs, three db reads. */
const SETTLING_MS = 20_000;

/** The message `docs/demo-script.md` ships, which reads two promises out of one sentence. */
const MESSAGE = {
  merchant: "Northwind Parcel",
  text: "Delivered between 9 and 11am, guaranteed or your money back.",
};

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "owed-restart-"));
  dbPath = join(dir, "owed.db");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A port nothing is on, taken by binding rather than by hoping. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        probe.close(() => reject(new Error("no port")));
        return;
      }
      probe.close(() => resolve(address.port));
    });
  });
}

interface Booted {
  output: string;
  stop: () => Promise<void>;
}

/**
 * Boot the real server on this ledger and wait until it says it is listening.
 *
 * `OWED_DYNAMO_TABLE` is deleted rather than blanked: `main.ts` tests both with `!== undefined`
 * and refuses to start when each has a value, so an empty string would be two homes for one
 * ledger. `capture-demo.mjs` deletes it for the same reason.
 */
async function boot(port: number): Promise<Booted> {
  if (!existsSync(MAIN)) {
    throw new Error(`${MAIN} is missing — run \`pnpm build\`; this test drives the real process.`);
  }

  const env: NodeJS.ProcessEnv = { ...process.env, OWED_DB: dbPath, OWED_PORT: String(port) };
  delete env.OWED_DYNAMO_TABLE;

  const child = spawn(process.execPath, [MAIN], { env, stdio: ["ignore", "pipe", "pipe"] });
  const state = { output: "", exited: false };
  child.stdout.on("data", (chunk) => {
    state.output += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    state.output += String(chunk);
  });
  child.on("exit", () => {
    state.exited = true;
  });

  const deadline = Date.now() + BOOT_MS;
  while (Date.now() < deadline && !state.exited && !state.output.includes("Owed MCP server on")) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!state.output.includes("Owed MCP server on")) {
    throw new Error(`the server did not come up in ${BOOT_MS}ms:\n${state.output}`);
  }

  return {
    output: state.output,
    // SIGTERM rather than SIGKILL: `main.ts` closes the store on it, and an unclosed SQLite
    // store leaves a WAL the next boot has to recover before it can read anything.
    stop: async () => {
      if (state.exited) return;
      child.kill("SIGTERM");
      const end = Date.now() + 5_000;
      while (Date.now() < end && !state.exited) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      if (!state.exited) child.kill("SIGKILL");
    },
  };
}

/** Read the ledger the way anything else would, once nothing is holding it open. */
async function ledger(): Promise<StoredLedgerEvent[]> {
  const store = new SqliteEventStore(dbPath);
  try {
    return await store.read(HOUSEHOLD_ID);
  } finally {
    await store.close();
  }
}

/**
 * Every id this batch *mints*, which is not every id-shaped string in it.
 *
 * References have to be excluded or the check fails on correct data: `Recovered.evidence_id`
 * names an `evd_` that is also an `EvidenceObserved`'s own id, and `claim_id` repeats on every
 * event of a claim. These four are the minting sites.
 */
function mintedIdsIn(events: readonly StoredLedgerEvent[]): string[] {
  const minted: string[] = [];
  for (const event of events) {
    minted.push(event.id);
    if (event.type === "PromiseCaptured") minted.push(event.promise.id);
    if (event.type === "EvidenceObserved") minted.push(event.evidence.id);
    if (event.type === "PromiseAssessed") minted.push(event.assessment.id);
  }
  return minted;
}

const promiseIdsOf = (events: readonly StoredLedgerEvent[]): string[] =>
  events.flatMap((event) => (event.type === "PromiseCaptured" ? [event.promise.id] : []));

describe("the ledger on disk, across a restart", () => {
  it("seeds once, says so the second time, and hands out no id the week already used", {
    timeout: BOOT_MS + BOOT_MS + SETTLING_MS,
  }, async () => {
    const port = await freePort();

    const first = await boot(port);
    expect(first.output, "a fresh file is seeded, not reported as already full").not.toMatch(
      /not reseeding/,
    );
    await first.stop();

    const seeded = await ledger();
    expect(seeded.length, "the first boot wrote the week").toBeGreaterThan(0);
    const seededIds = mintedIdsIn(seeded);
    expect(seededIds.length, "the week mints ids").toBeGreaterThan(0);

    // ---- the restart -------------------------------------------------------------------
    const second = await boot(port);
    expect(second.output, "the second boot must recognise the ledger it found").toMatch(
      new RegExp(`${seeded.length} events already in .*, not reseeding`),
    );

    const afterBoot = await ledger();
    expect(afterBoot.length, "a restart must not append a second copy of the week").toBe(
      seeded.length,
    );

    // ---- a promise captured live, after the restart -------------------------------------
    const delivered = await fetch(`http://127.0.0.1:${port}/control/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(MESSAGE),
    });
    expect(delivered.ok, `POST /control/messages: ${delivered.status}`).toBe(true);
    await second.stop();

    const afterMessage = await ledger();
    const allIds = mintedIdsIn(afterMessage);
    expect(
      allIds.length - seededIds.length,
      "the message has to write something, or this proves nothing",
    ).toBeGreaterThan(0);

    const duplicated = [...new Set(allIds.filter((id, i) => allIds.indexOf(id) !== i))];
    expect(
      duplicated,
      "the counters started from zero against a ledger that already had a week in it, so a " +
        "capture after the restart minted an id the seeded week is already using",
    ).toStrictEqual([]);

    // And the week is still readable as itself, which is what a collision would spoil.
    const state = project(afterMessage);
    for (const id of promiseIdsOf(seeded)) {
      expect(state.promises.has(id), `seeded promise ${id} survived the restart`).toBe(true);
    }
  });
});
