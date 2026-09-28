import {
  type Evidence,
  type Instant,
  type Interval,
  interval,
  type LedgerEvent,
  type Money,
  normalizeInstant,
  type OwedPromise,
  type PromiseKind,
  usd,
} from "@owed/domain";
import { arcEvents, resetIds, sortByOccurrence } from "./build.js";
import type { ArcSpec } from "./types.js";

export const HOUSEHOLD_ID = "hh_demo";
export const CURRENCY = "USD";

/** Merchants are invented. Submission rules bar third-party trademarks (plan §2.2f). */
export const MERCHANTS = {
  parcel: "Northwind Parcel",
  rides: "Meridian Rides",
  retail: "Calder & Co.",
  home: "Alder Home Services",
} as const;

const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type Day = (typeof DAYS)[number];

/** Any calendar date in the household's timezone. */
export function atDate(isoDate: string, hhmm: string): Instant {
  return normalizeInstant(`${isoDate}T${hhmm}:00-07:00`);
}

/** Week of Mon 2026-10-05, America/Los_Angeles. docs/contract-v1.md §6. */
export function at(day: Day, hhmm: string): Instant {
  return atDate(`2026-10-${String(5 + DAYS.indexOf(day)).padStart(2, "0")}`, hhmm);
}

export const STORYBOARD_START = at("mon", "00:00");
export const STORYBOARD_END = at("sun", "23:59");
/** When the judge asks "what am I owed?" */
export const STORYBOARD_QUERY_AT = at("sun", "19:30");
/** When Owed speaks first about the phantom delivery. */
export const STORYBOARD_PROACTIVE_AT = at("tue", "18:40");

function promise(
  id: string,
  merchant: string,
  kind: PromiseKind,
  made_at: Instant,
  extra: Partial<OwedPromise> = {},
): OwedPromise {
  return {
    id,
    household_id: HOUSEHOLD_ID,
    merchant,
    source_ref: `msg_${id}`,
    kind,
    made_at,
    currency: CURRENCY,
    confidence: 0.96,
    status: "Watching",
    ...extra,
  };
}

// --- evidence helpers ------------------------------------------------------

let evidenceSeq = 0;
function evidenceId(prefix: string): string {
  evidenceSeq += 1;
  return `${prefix}_${String(evidenceSeq).padStart(3, "0")}`;
}

export function resetEvidenceIds(): void {
  evidenceSeq = 0;
}

const base = (promise_id: string, source_id: string, captured_at: Instant) => ({
  household_id: HOUSEHOLD_ID,
  source_id,
  promise_id,
  captured_at,
});

const carrierScan = (promise_id: string, captured_at: Instant): Evidence => ({
  id: evidenceId("evd_scan"),
  ...base(promise_id, "src_carrier", captured_at),
  kind: "carrier_scan",
  status: "delivered",
  carrier: MERCHANTS.parcel,
});

const arrived = (promise_id: string, captured_at: Instant): Evidence => ({
  id: evidenceId("evd_time"),
  ...base(promise_id, "src_rides", captured_at),
  kind: "timestamp",
  label: "arrived",
});

const packagePlaced = (promise_id: string, captured_at: Instant): Evidence => ({
  id: evidenceId("evd_door"),
  ...base(promise_id, "src_doorbell", captured_at),
  kind: "doorbell_event",
  event: "package_placed",
});

const personAtDoor = (promise_id: string, captured_at: Instant): Evidence => ({
  id: evidenceId("evd_door"),
  ...base(promise_id, "src_doorbell", captured_at),
  kind: "doorbell_event",
  event: "person_detected",
});

const snapshot = (promise_id: string, captured_at: Instant): Evidence => ({
  id: evidenceId("evd_snap"),
  ...base(promise_id, "src_doorbell", captured_at),
  kind: "doorbell_snapshot",
  uri: `scenario://doorbell/${captured_at}.jpg`,
});

const priceSeen = (promise_id: string, captured_at: Instant, amount: Money): Evidence => ({
  id: evidenceId("evd_price"),
  ...base(promise_id, "src_inbox", captured_at),
  kind: "price_observed",
  amount,
  source: MERCHANTS.retail,
});

const clause = (text: string, evidence_ids: string[], coverage_statement?: string) => ({
  policy_clause: text,
  evidence_ids,
  ...(coverage_statement === undefined ? {} : { coverage_statement }),
});

const settled = (at_: Instant, amount: Money, recovered_at?: Instant) => ({
  kind: "settled" as const,
  at: at_,
  amount,
  form: "credit" as const,
  ...(recovered_at === undefined ? {} : { recovered_at }),
});

// ---------------------------------------------------------------------------

/**
 * The seeded week.
 *
 * Each arc states what was *observed* — carrier scans, doorbell events, camera uptime,
 * prices — and the breach engine decides what it means. Nothing here asserts a verdict.
 */
export function buildArcs(): ArcSpec[] {
  resetEvidenceIds();

  // 2 — Tuesday's hero claim. The camera was up across the scan hour except 13:51-14:02,
  // which is 49 of 60 minutes, and the moment of the scan itself was watched.
  const heroUptime: Interval[] = [
    interval(at("tue", "13:42"), at("tue", "13:51")),
    interval(at("tue", "14:02"), at("tue", "14:42")),
  ];
  const heroScan = carrierScan("prm_002", at("tue", "14:12"));
  const heroSnapshots = [
    snapshot("prm_002", at("tue", "14:11")),
    snapshot("prm_002", at("tue", "14:13")),
  ];

  return [
    // 1 — Monday: a ride that took far longer to arrive than promised.
    {
      promise: promise("prm_001", MERCHANTS.rides, "eta", at("mon", "08:15"), {
        deadline: at("mon", "08:20"),
        amount_at_stake: usd(24.8),
      }),
      evidence: [arrived("prm_001", at("mon", "08:34"))],
      assessed_at: at("mon", "08:34"),
      claim: {
        id: "clm_001",
        ask: usd(5),
        proposed_at: at("mon", "08:40"),
        filed_at: at("mon", "09:02"),
        confirmed_by: "household",
        exchanges: [{ type: "OFFER", at: at("mon", "09:03"), amount: usd(3), form: "credit" }],
        outcome: settled(at("mon", "09:04"), usd(3), at("mon", "17:20")),
      },
    },

    // 2 — Tuesday: scanned delivered; the door was watching and saw nobody.
    {
      promise: promise("prm_002", MERCHANTS.parcel, "delivery_window", at("mon", "19:02"), {
        window: interval(at("tue", "12:00"), at("tue", "16:00")),
        amount_at_stake: usd(68.4),
        policy_ref: "northwind/delivery-guarantee#4.2",
      }),
      evidence: [heroScan, ...heroSnapshots],
      uptime: heroUptime,
      assessed_at: at("tue", "14:42"),
      claim: {
        id: "clm_002",
        ask: usd(15),
        proposed_at: at("tue", "14:45"),
        filed_at: STORYBOARD_PROACTIVE_AT,
        confirmed_by: "household",
        attached_evidence_ids: heroSnapshots.map((s) => s.id),
        exchanges: [
          { type: "OFFER", at: at("tue", "18:40"), amount: usd(5), form: "credit" },
          {
            type: "COUNTER",
            at: at("tue", "18:40"),
            amount: usd(12),
            justification: clause(
              "Delivery Guarantee 4.2",
              [heroScan.id, ...heroSnapshots.map((s) => s.id)],
              "Doorbell coverage of the scan window was 82%, including the moment of the scan.",
            ),
          },
        ],
        outcome: settled(at("tue", "18:41"), usd(12), at("wed", "10:05")),
      },
    },

    // 3 — Wednesday: an engineer who never showed. The door watched 160 of the 180
    // minutes around the slot and recorded nobody.
    {
      promise: promise("prm_003", MERCHANTS.home, "appointment_slot", at("mon", "11:00"), {
        window: interval(at("wed", "13:00"), at("wed", "15:00")),
        policy_ref: "alder/appointment-promise#2",
      }),
      uptime: [interval(at("wed", "12:30"), at("wed", "15:10"))],
      assessed_at: at("wed", "15:30"),
      claim: {
        id: "clm_003",
        ask: usd(12),
        proposed_at: at("wed", "15:35"),
        filed_at: at("wed", "18:10"),
        confirmed_by: "household",
        exchanges: [
          { type: "OFFER", at: at("wed", "18:11"), amount: usd(6), form: "credit" },
          {
            type: "COUNTER",
            at: at("wed", "18:11"),
            amount: usd(9),
            justification: clause("Appointment Promise 2", []),
          },
        ],
        outcome: settled(at("wed", "18:12"), usd(9), at("wed", "21:40")),
      },
    },

    // 4 — Thursday: a refund promised in five to seven days, now on day eleven.
    {
      promise: promise("prm_004", MERCHANTS.retail, "refund_sla", atDate("2026-09-27", "09:00"), {
        deadline: atDate("2026-10-04", "09:00"),
        amount_at_stake: usd(112),
        policy_ref: "calder/refund-policy#1.1",
      }),
      assessed_at: at("thu", "09:05"),
      claim: {
        id: "clm_004",
        ask: usd(5),
        proposed_at: at("thu", "09:10"),
        filed_at: at("thu", "12:15"),
        confirmed_by: "household",
        exchanges: [],
        outcome: {
          kind: "escalated",
          at: at("thu", "12:20"),
          reason: "Declined twice without addressing the promised window.",
          route: "Calder & Co. customer relations",
        },
      },
    },

    // 5 — Friday: a price match the household would never have noticed.
    {
      promise: promise("prm_005", MERCHANTS.retail, "price_match", atDate("2026-09-28", "16:30"), {
        window: interval(atDate("2026-09-28", "16:30"), atDate("2026-10-12", "16:30")),
        amount_at_stake: usd(89.99),
        policy_ref: "calder/price-promise#3",
      }),
      evidence: [priceSeen("prm_005", at("fri", "11:00"), usd(74.99))],
      assessed_at: at("fri", "11:00"),
      claim: {
        id: "clm_005",
        ask: usd(15),
        proposed_at: at("fri", "11:05"),
        filed_at: at("fri", "13:00"),
        confirmed_by: "household",
        exchanges: [{ type: "OFFER", at: at("fri", "13:01"), amount: usd(15), form: "credit" }],
        outcome: settled(at("fri", "13:02"), usd(15), at("sat", "09:15")),
      },
    },

    // 6 — Saturday: a delivery that did arrive, hours after the window closed.
    {
      promise: promise("prm_006", MERCHANTS.parcel, "delivery_window", at("fri", "18:40"), {
        window: interval(at("sat", "09:00"), at("sat", "13:00")),
        amount_at_stake: usd(41.5),
        policy_ref: "northwind/delivery-guarantee#4.1",
      }),
      evidence: [
        carrierScan("prm_006", at("sat", "15:20")),
        packagePlaced("prm_006", at("sat", "15:20")),
      ],
      uptime: [interval(at("sat", "09:00"), at("sat", "16:00"))],
      assessed_at: at("sat", "15:20"),
      claim: {
        id: "clm_006",
        ask: usd(10),
        proposed_at: at("sat", "15:25"),
        filed_at: at("sat", "16:00"),
        confirmed_by: "household",
        exchanges: [
          { type: "OFFER", at: at("sat", "16:01"), amount: usd(3), form: "credit" },
          {
            type: "COUNTER",
            at: at("sat", "16:01"),
            amount: usd(8),
            justification: clause("Delivery Guarantee 4.1", []),
          },
        ],
        outcome: settled(at("sat", "16:02"), usd(8), at("sat", "19:00")),
      },
    },

    // 7 — Sunday: filed and still being argued. Open money.
    {
      promise: promise("prm_007", MERCHANTS.rides, "eta", at("sun", "11:20"), {
        deadline: at("sun", "11:25"),
        amount_at_stake: usd(18.4),
      }),
      evidence: [arrived("prm_007", at("sun", "11:41"))],
      assessed_at: at("sun", "11:41"),
      claim: {
        id: "clm_007",
        ask: usd(3),
        proposed_at: at("sun", "11:45"),
        filed_at: at("sun", "12:10"),
        confirmed_by: "household",
        exchanges: [{ type: "OFFER", at: at("sun", "12:11"), amount: usd(1), form: "credit" }],
        outcome: { kind: "open" },
      },
    },

    // 8 & 9 — promises that were simply kept. The system says so.
    {
      promise: promise("prm_008", MERCHANTS.parcel, "delivery_window", at("wed", "20:10"), {
        window: interval(at("thu", "10:00"), at("thu", "14:00")),
        amount_at_stake: usd(32),
      }),
      evidence: [
        carrierScan("prm_008", at("thu", "11:48")),
        packagePlaced("prm_008", at("thu", "11:48")),
      ],
      uptime: [interval(at("thu", "10:00"), at("thu", "14:00"))],
      assessed_at: at("thu", "14:00"),
    },
    {
      promise: promise("prm_009", MERCHANTS.home, "appointment_slot", at("tue", "09:30"), {
        window: interval(at("fri", "08:00"), at("fri", "10:00")),
      }),
      evidence: [personAtDoor("prm_009", at("fri", "08:22"))],
      uptime: [interval(at("fri", "07:30"), at("fri", "10:30"))],
      assessed_at: at("fri", "10:00"),
    },

    // 10 — the trust beat. Same story as Tuesday, but the camera was barely on.
    {
      promise: promise("prm_010", MERCHANTS.parcel, "delivery_window", at("sat", "20:00"), {
        window: interval(at("sun", "14:00"), at("sun", "18:00")),
        amount_at_stake: usd(27.25),
        policy_ref: "northwind/delivery-guarantee#4.2",
      }),
      evidence: [carrierScan("prm_010", at("sun", "16:40"))],
      uptime: [interval(at("sun", "16:20"), at("sun", "16:32"))],
      assessed_at: at("sun", "17:10"),
    },
  ];
}

export const ARCS: ArcSpec[] = buildArcs();

/** The whole seeded week, in occurrence order. */
export function storyboardEvents(): LedgerEvent[] {
  resetIds();
  return sortByOccurrence(buildArcs().flatMap((arc) => arcEvents(HOUSEHOLD_ID, arc)));
}
