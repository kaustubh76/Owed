import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryEventStore, project } from "@owed/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { at, HOUSEHOLD_ID, storyboardEvents } from "../seed/storyboard.js";
import { SqliteEventStore } from "./sqlite.js";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "owed-sqlite-"));
  path = join(dir, "ledger.db");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("the ledger on disk", () => {
  it("reads back exactly what the memory store would have", async () => {
    const events = await storyboardEvents();
    const instant = at("sun", "19:30");

    const memory = new MemoryEventStore();
    await memory.append(events);

    const disk = new SqliteEventStore(path);
    await disk.append(events);

    expect(await disk.read(HOUSEHOLD_ID, instant)).toEqual(
      await memory.read(HOUSEHOLD_ID, instant),
    );
    disk.close();
  });

  /** The whole point of persisting it. */
  it("survives the process that wrote it", async () => {
    const events = await storyboardEvents();

    const first = new SqliteEventStore(path);
    await first.append(events);
    const before = await first.read(HOUSEHOLD_ID);
    first.close();

    const second = new SqliteEventStore(path);
    expect(await second.read(HOUSEHOLD_ID)).toEqual(before);
    second.close();
  });

  /**
   * Replaying to an instant is the scrubber, and it has to mean the same thing on disk
   * as it does in memory — a narrower read, not a different answer.
   */
  it("replays to any instant, and the projection agrees", async () => {
    const events = await storyboardEvents();
    const disk = new SqliteEventStore(path);
    const memory = new MemoryEventStore();
    await disk.append(events);
    await memory.append(events);

    for (const day of ["mon", "wed", "fri", "sun"] as const) {
      const instant = at(day, "19:30");
      const fromDisk = project(await disk.read(HOUSEHOLD_ID, instant));
      const fromMemory = project(await memory.read(HOUSEHOLD_ID, instant));
      expect([...fromDisk.promises.keys()]).toEqual([...fromMemory.promises.keys()]);
      expect([...fromDisk.claims.keys()]).toEqual([...fromMemory.claims.keys()]);
    }
    disk.close();
  });

  it("keeps households apart", async () => {
    const disk = new SqliteEventStore(path);
    await disk.append(await storyboardEvents());
    expect(await disk.read("hh_somebody_else")).toEqual([]);
    disk.close();
  });

  it("numbers events in the order they were appended, across calls", async () => {
    const events = await storyboardEvents();
    const disk = new SqliteEventStore(path);

    await disk.append(events.slice(0, 5));
    await disk.append(events.slice(5));

    const all = await disk.read(HOUSEHOLD_ID);
    expect(all.map((event) => event.seq)).toEqual(all.map((_, index) => index));
    disk.close();
  });

  /**
   * Append-only is a promise about the data, so it is checked against the data rather
   * than trusted to the code that writes it.
   */
  it("never rewrites an event that is already there", async () => {
    const events = await storyboardEvents();
    const disk = new SqliteEventStore(path);
    await disk.append(events);

    const before = await disk.read(HOUSEHOLD_ID);
    await disk.append(events.slice(0, 3));
    const after = await disk.read(HOUSEHOLD_ID);

    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.length).toBe(before.length + 3);
    disk.close();
  });

  it("refuses to hand back a row that is no longer a valid event", async () => {
    const disk = new SqliteEventStore(path);
    await disk.append((await storyboardEvents()).slice(0, 2));
    disk.close();

    // Reach past the store and corrupt one row, the way a stale write or a hand edit
    // would. Parsing on read is what turns that into a loud failure.
    const { DatabaseSync } = await import("node:sqlite");
    const raw = new DatabaseSync(path);
    raw.prepare("UPDATE events SET payload = ? WHERE seq = 0").run('{"type":"NotAnEvent"}');
    raw.close();

    const reopened = new SqliteEventStore(path);
    await expect(reopened.read(HOUSEHOLD_ID)).rejects.toThrow();
    reopened.close();
  });
});
