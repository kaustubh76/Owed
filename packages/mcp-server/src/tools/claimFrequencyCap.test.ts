import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { project } from "@owed/core";
import type { LedgerEvent } from "@owed/domain";
import { addMs, CLAIM_WINDOW_DAYS, DAY_MS, MAX_CLAIMS_PER_MERCHANT, usd } from "@owed/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Harness, startHarness } from "../testing/harness.js";
import { claimsAgainstMerchantSince } from "./projections.js";

/**
 * The per-merchant claim cap — `product_ideation.md` §10, "per-merchant claim frequency cap
 * to avoid vexatious filing".
 *
 * It was the one required safety property in that list with no implementation, and unlike the
 * Fire TV overlay, the phone rail and speaker identity it was not recorded as not-built in the
 * readme's real-vs-simulated table either. So it was neither built nor disclosed, which is the
 * worse of the two ways to not have something.
 *
 * Three mechanisms already bounded the same risk and still do: `claim_file` is idempotent per
 * promise, a claim needs a breach past both gates, and nothing files without the household's
 * explicit yes. None of them stops a household working through twenty genuine breaches from
 * one merchant in an afternoon, which is the behaviour a merchant experiences as vexatious.
 *
 * The cap is five in seven days, chosen against the week the demo records rather than for
 * strictness: seven claims across four merchants, at most two per merchant, three for
 * Northwind Parcel once the demo files `prm_011` on camera. The tests below pin both ends —
 * that the storyboard files comfortably under it, and that it refuses when crossed.
 */

const MERCHANT = "Northwind Parcel";

/** The promise the demo files on camera, and the one left unfiled by the seed. */
const PROMISE = "prm_011";

let harness: Harness;
let client: Client;

beforeEach(async () => {
  harness = await startHarness();
  const token = await harness.link();
  client = new Client({ name: "claim-cap-test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(harness.mcpUrl, {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
});

afterEach(async () => {
  await client?.close();
  await harness?.close();
});

const spokenOf = (result: { content: unknown }) =>
  (result.content as Array<{ text?: string }>)[0]?.text ?? "";

/**
 * Claims this household already filed against the merchant, inside the window.
 *
 * `ClaimProposed` alone is not enough: the projection gives a proposed claim no rounds, and
 * the counter dates a claim by its opening `CLAIM` round — which `ClaimFiled` is what adds.
 * That is deliberate, and this helper has to match it, because a claim that was never sent is
 * not one a merchant experienced.
 */
async function seedFiledClaims(count: number): Promise<void> {
  const now = harness.deps.clock.now();
  const events: LedgerEvent[] = [];
  for (let index = 0; index < count; index += 1) {
    // Spread across the window, all of it inside.
    const at = addMs(now, -Math.floor(((index + 1) * DAY_MS * (CLAIM_WINDOW_DAYS - 1)) / count));
    const claimId = `clm_cap_${index}`;
    const base = {
      household_id: harness.deps.householdId,
      occurred_at: at,
      recorded_at: at,
    };
    events.push({
      ...base,
      id: `evt_cap_proposed_${index}`,
      type: "ClaimProposed",
      claim_id: claimId,
      promise_id: `prm_cap_${index}`,
      merchant: MERCHANT,
      ask: usd(10),
      expected: usd(8),
      route: "agent",
    });
    events.push({
      ...base,
      id: `evt_cap_filed_${index}`,
      type: "ClaimFiled",
      claim_id: claimId,
      promise_id: `prm_cap_${index}`,
      confirmed_by: "household",
      attached_evidence_ids: [],
    });
  }
  await harness.deps.store.append(events);
}

/**
 * What the counter sees right now, through the same path the guard uses.
 *
 * The seed already files claims against this merchant, so a test that assumed zero seeded
 * two too many and refused when it meant to allow — which is how the first draft of this
 * file failed. Reading the baseline makes the tests say what they mean at any seed size.
 */
async function filedThisWeek(): Promise<number> {
  const now = harness.deps.clock.now();
  const state = project(await harness.deps.store.read(harness.deps.householdId, now));
  return claimsAgainstMerchantSince(state, MERCHANT, addMs(now, -CLAIM_WINDOW_DAYS * DAY_MS));
}

/** Top the merchant up to exactly `target` filed claims inside the window. */
async function seedUpTo(target: number): Promise<void> {
  await seedFiledClaims(Math.max(0, target - (await filedThisWeek())));
}

const fileIt = () => client.callTool({ name: "claim_file", arguments: { promise_id: PROMISE } });

describe("the per-merchant claim frequency cap", () => {
  /**
   * The property that protects the submission: the recorded week is nowhere near the cap.
   *
   * If this ever fails, the cap has been set too low and the storyboard is what breaks —
   * which is the one outcome that is never worth a safety property.
   */
  it("never touches the week the demo records", async () => {
    // The margin, stated: the recorded week must sit under the cap with room to file the
    // one the demo files on camera. If this fails, the cap is too low and the storyboard is
    // what breaks — the one outcome never worth a safety property.
    expect(await filedThisWeek()).toBeLessThan(MAX_CLAIMS_PER_MERCHANT);

    const result = await fileIt();

    expect(result.isError ?? false, spokenOf(result)).toBe(false);
    expect(spokenOf(result)).not.toMatch(/hold this one back/);
    expect(await filedThisWeek(), "the demo's claim is counted too").toBeLessThanOrEqual(
      MAX_CLAIMS_PER_MERCHANT,
    );
  });

  it("refuses once the merchant has had its share this week", async () => {
    await seedUpTo(MAX_CLAIMS_PER_MERCHANT);

    const result = await fileIt();

    expect(result.isError).toBe(true);
    expect(spokenOf(result)).toMatch(/already filed five claims against Northwind Parcel/);
    expect(spokenOf(result), "no digits may be spoken").not.toMatch(/[0-9]/);
  });

  /** One under the cap still files, so this is a boundary rather than a blanket refusal. */
  it("files the last one the cap allows", async () => {
    await seedUpTo(MAX_CLAIMS_PER_MERCHANT - 1);

    const result = await fileIt();

    expect(result.isError ?? false, spokenOf(result)).toBe(false);
  });

  /** Counted per merchant, or one busy merchant would silence the others. */
  it("counts each merchant separately", async () => {
    await seedUpTo(MAX_CLAIMS_PER_MERCHANT);

    // Northwind is capped. `prm_007` is Meridian Rides and the seed has already filed it,
    // so this comes back through the idempotent path — which is the point: a capped
    // merchant must not interfere with another merchant's claim on the way out.
    const theirs = await client.callTool({
      name: "claim_file",
      arguments: { promise_id: "prm_007" },
    });

    expect(spokenOf(theirs)).not.toMatch(/hold this one back/);
    expect(theirs.isError ?? false, spokenOf(theirs)).toBe(false);
  });

  /** Claims older than the window have been paid for and must not count forever. */
  it("forgets claims older than the window", async () => {
    const now = harness.deps.clock.now();
    const stale = addMs(now, -(CLAIM_WINDOW_DAYS + 1) * DAY_MS);
    const events: LedgerEvent[] = [];
    for (let index = 0; index < MAX_CLAIMS_PER_MERCHANT + 3; index += 1) {
      const claimId = `clm_old_${index}`;
      const base = {
        household_id: harness.deps.householdId,
        occurred_at: stale,
        recorded_at: stale,
      };
      events.push({
        ...base,
        id: `evt_old_proposed_${index}`,
        type: "ClaimProposed",
        claim_id: claimId,
        promise_id: `prm_old_${index}`,
        merchant: MERCHANT,
        ask: usd(10),
        expected: usd(8),
        route: "agent",
      });
      events.push({
        ...base,
        id: `evt_old_filed_${index}`,
        type: "ClaimFiled",
        claim_id: claimId,
        promise_id: `prm_old_${index}`,
        confirmed_by: "household",
        attached_evidence_ids: [],
      });
    }
    await harness.deps.store.append(events);

    const result = await fileIt();

    expect(result.isError ?? false, spokenOf(result)).toBe(false);
  });
});
