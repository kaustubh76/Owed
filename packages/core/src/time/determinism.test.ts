import { describe, expect, it } from "vitest";
import { SeededIdGen } from "./determinism.js";

/**
 * `observe` exists for one situation: a server that finds a ledger already in DynamoDB or
 * on disk does not reseed it, so the generator starts at zero while ids like `clm_000001`
 * already exist. The next claim filed would then be handed an id that is already in the
 * ledger — and because the idempotency check reads the ledger back, it would look like a
 * claim that had already been filed, so nothing would happen.
 *
 * Impossible to hit with an in-memory store, which reseeds on every boot. That is why it
 * survived until the ledger moved to real persistence.
 */
describe("SeededIdGen", () => {
  it("counts from one", () => {
    const gen = new SeededIdGen();
    expect(gen.next("clm")).toBe("clm_000001");
    expect(gen.next("clm")).toBe("clm_000002");
  });

  it("counts each prefix separately", () => {
    const gen = new SeededIdGen();
    expect(gen.next("clm")).toBe("clm_000001");
    expect(gen.next("prm")).toBe("prm_000001");
  });

  it("continues past an id it has been shown", () => {
    const gen = new SeededIdGen();
    gen.observe("clm_000005");
    expect(gen.next("clm")).toBe("clm_000006");
  });

  it("takes the highest it has seen, in any order", () => {
    const gen = new SeededIdGen();
    gen.observe("clm_000009");
    gen.observe("clm_000002");
    expect(gen.next("clm")).toBe("clm_000010");
  });

  it("leaves other prefixes alone", () => {
    const gen = new SeededIdGen();
    gen.observe("clm_000009");
    expect(gen.next("prm")).toBe("prm_000001");
  });

  /** Pointed at whole event payloads, so most of what it sees is not an id. */
  it("ignores anything that is not one of our ids", () => {
    const gen = new SeededIdGen();
    for (const value of [
      "hh_demo",
      "Northwind Parcel",
      "2026-10-05T16:00:00.000Z",
      "clm_12",
      "clm_0000012",
      "CLM_000001",
      "",
      "ui://owed/claim",
    ]) {
      gen.observe(value);
    }
    expect(gen.next("clm")).toBe("clm_000001");
  });

  it("is reset by reset()", () => {
    const gen = new SeededIdGen();
    gen.observe("clm_000005");
    gen.reset();
    expect(gen.next("clm")).toBe("clm_000001");
  });
});
