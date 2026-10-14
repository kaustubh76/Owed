import { describe, expect, it } from "vitest";
import type { EventOfType, LedgerEvent } from "./events.js";
import {
  type CarrierScanStatus,
  CarrierScanStatusSchema,
  type DoorbellEventType,
  DoorbellEventTypeSchema,
  type EvidenceBundle,
  EvidenceBundleSchema,
} from "./evidence.js";

/**
 * Four names in this package's vocabulary that nothing referenced.
 *
 * Each is the inferred type beside a schema, or a helper over the event union. They are
 * not API surface — `@owed/domain` is `private: true` — and there is no call site that
 * genuinely wants them: the detectors narrow evidence through the `isCarrierScan` family
 * and get the status and the event type for free, and `AssessPromiseInput` takes the
 * bundle's two fields as `readonly` arrays, which composing `EvidenceBundle` in would
 * weaken.
 *
 * So the same treatment as `minMoney`/`maxMoney` in `money.test.ts`: rather than force a
 * call site where none belongs, they are guaranteed. A type alias can drift from the
 * schema it was inferred from — someone edits the enum and the alias stops covering it,
 * or a schema is renamed and the alias points at the wrong one — and nothing would fail.
 * `tsc -b` checks every annotation below, so these are checks and not decoration.
 */

describe("the vocabulary beside the schemas", () => {
  it("names every carrier scan status the schema allows, and nothing else", () => {
    const statuses: CarrierScanStatus[] = [...CarrierScanStatusSchema.options];

    for (const status of statuses) {
      expect(CarrierScanStatusSchema.safeParse(status).success, status).toBe(true);
    }
    // The one the detectors turn on. If it were renamed, the annotation above would fail.
    const delivered: CarrierScanStatus = "delivered";
    expect(statuses).toContain(delivered);
  });

  it("names every doorbell event type the schema allows", () => {
    const types: DoorbellEventType[] = [...DoorbellEventTypeSchema.options];

    for (const type of types) {
      expect(DoorbellEventTypeSchema.safeParse(type).success, type).toBe(true);
    }
    // The two a phantom delivery is decided on: somebody came, or a parcel was put down.
    const person: DoorbellEventType = "person_detected";
    const placed: DoorbellEventType = "package_placed";
    expect(types).toContain(person);
    expect(types).toContain(placed);
  });

  /** Everything a breach detector is handed about one promise, as the comment says. */
  it("describes an evidence bundle the schema parses", () => {
    const bundle: EvidenceBundle = {
      evidence: [
        {
          id: "evd_scan_012",
          household_id: "hh_demo",
          source_id: "src_carrier",
          promise_id: "prm_011",
          kind: "carrier_scan",
          captured_at: "2026-10-12T01:20:00.000Z",
          status: "delivered",
        },
      ],
      uptime: [
        {
          source_id: "src_doorbell",
          household_id: "hh_demo",
          interval: {
            start: "2026-10-11T20:00:00.000Z",
            end: "2026-10-12T00:00:00.000Z",
          },
        },
      ],
    };

    expect(EvidenceBundleSchema.parse(bundle)).toStrictEqual(bundle);
  });

  /**
   * `EventOfType` picks one member out of the ledger's event union by its `type`.
   *
   * Worth having and worth checking: the union has fourteen members, and anything that
   * wants to hold "a `ClaimProposed`, specifically" would otherwise write the `Extract`
   * by hand. The annotations here fail to compile if the union stops carrying that
   * member or the member's shape changes.
   */
  it("picks one event out of the union by its type", () => {
    const proposed: EventOfType<"ClaimProposed"> = {
      id: "evt_1",
      household_id: "hh_demo",
      occurred_at: "2026-10-12T02:30:00.000Z",
      recorded_at: "2026-10-12T02:30:00.000Z",
      type: "ClaimProposed",
      claim_id: "clm_prm_011",
      promise_id: "prm_011",
      merchant: "Northwind Parcel",
      ask: { minor: 1000, currency: "USD" },
      expected: { minor: 800, currency: "USD" },
      route: "agent",
    };

    // It is a `LedgerEvent`, narrower than one, and carries the fields only this member has.
    const asEvent: LedgerEvent = proposed;
    expect(asEvent.type).toBe("ClaimProposed");
    expect(proposed.route).toBe("agent");
    expect(proposed.ask).toStrictEqual({ minor: 1000, currency: "USD" });
  });
});
