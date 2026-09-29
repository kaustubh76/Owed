import type {
  BreachKind,
  Evidence,
  Instant,
  Interval,
  Money,
  ObservationWindow,
  OwedPromise,
  PromiseKind,
} from "@owed/domain";
import { addMs, interval, normalizeInstant, usd } from "@owed/domain";

/**
 * One scripted timeline.
 *
 * `label` is what the timeline was *built* to represent and is set by its construction —
 * a parcel scanned eighty minutes after the window closed is broken whatever any
 * detector says about it. Nothing here consults the breach engine, which is the only way
 * a measurement of that engine means anything.
 */
export interface BreachCase {
  id: string;
  /** The breach kind this timeline was written to exercise. */
  target: BreachKind;
  label: "broken" | "kept";
  /**
   * Whether enough of the window was watched for a verdict to be claimable.
   *
   * H2 measures precision at coverage >= 0.7. The cases below it are not failures
   * waiting to happen — they are where Owed is supposed to hold back and say so, which
   * is the claim the whole product rests on.
   */
  observable: boolean;
  /** One line a human can check the label against without running anything. */
  note: string;
  promise: OwedPromise;
  evidence: Evidence[];
  uptime: ObservationWindow[];
  now: Instant;
}

const HOUSEHOLD = "hh_corpus";
const MERCHANT = "Corpus Merchant";
const DOORBELL = "src_doorbell";

/** A week of its own, well clear of the storyboard's, so nothing is ever confused. */
const BASE = normalizeInstant("2026-11-02T08:00:00-07:00");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const at = (ms: number): Instant => addMs(BASE, ms);
const span = (fromMs: number, toMs: number): Interval => interval(at(fromMs), at(toMs));

function promise(id: string, kind: PromiseKind, extra: Partial<OwedPromise> = {}): OwedPromise {
  return {
    id,
    household_id: HOUSEHOLD,
    merchant: MERCHANT,
    source_ref: `msg_${id}`,
    kind,
    made_at: at(0),
    currency: "USD",
    confidence: 0.97,
    status: "Watching",
    ...extra,
  };
}

const watching = (from: number, to: number): ObservationWindow => ({
  source_id: DOORBELL,
  household_id: HOUSEHOLD,
  interval: span(from, to),
});

let seq = 0;
const evidenceId = (prefix: string) => `evd_${prefix}_${String((seq += 1)).padStart(3, "0")}`;

const evidenceBase = (promise_id: string, source_id: string, ms: number) => ({
  household_id: HOUSEHOLD,
  source_id,
  promise_id,
  captured_at: at(ms),
});

const scan = (promise_id: string, ms: number): Evidence => ({
  id: evidenceId("scan"),
  ...evidenceBase(promise_id, "src_carrier", ms),
  kind: "carrier_scan",
  status: "delivered",
  carrier: MERCHANT,
});

const arrived = (promise_id: string, ms: number): Evidence => ({
  id: evidenceId("time"),
  ...evidenceBase(promise_id, "src_rides", ms),
  kind: "timestamp",
  label: "arrived",
});

const atDoor = (
  promise_id: string,
  ms: number,
  event: "package_placed" | "person_detected",
): Evidence => ({
  id: evidenceId("door"),
  ...evidenceBase(promise_id, DOORBELL, ms),
  kind: "doorbell_event",
  event,
});

const refunded = (promise_id: string, ms: number, amount: Money): Evidence => ({
  id: evidenceId("refund"),
  ...evidenceBase(promise_id, "src_bank", ms),
  kind: "refund_observed",
  amount,
});

const priceSeen = (promise_id: string, ms: number, amount: Money): Evidence => ({
  id: evidenceId("price"),
  ...evidenceBase(promise_id, "src_inbox", ms),
  kind: "price_observed",
  amount,
  source: MERCHANT,
});

// --- the six kinds ---------------------------------------------------------

/**
 * Lateness is read off a clock, so every case here is observable by construction.
 *
 * The interesting ones are at the edges: one minute late, and exactly on the deadline.
 */
function lateEtaCases(): BreachCase[] {
  const deadline = 2 * HOUR;
  const offsets = [1, 20, 90, 240, 480, -60, -30, -10, -2, 0];

  return offsets.map((offsetMinutes, index) => {
    const id = `eta_${String(index + 1).padStart(2, "0")}`;
    const arrivalMs = deadline + offsetMinutes * MINUTE;
    // One arrival reported by the carrier rather than the rider, because the detector
    // accepts either and nothing should hinge on which.
    const byCarrier = offsetMinutes === 480;
    return {
      id,
      target: "late_eta" as const,
      // Exactly on the deadline is kept: the promise was "by", not "before".
      label: offsetMinutes > 0 ? ("broken" as const) : ("kept" as const),
      observable: true,
      note:
        offsetMinutes > 0
          ? `arrived ${offsetMinutes} minutes late${byCarrier ? ", reported by the carrier" : ""}`
          : offsetMinutes === 0
            ? "arrived exactly on the promised time"
            : `arrived ${Math.abs(offsetMinutes)} minutes early`,
      promise: promise(id, "eta", { deadline: at(deadline), amount_at_stake: usd(20) }),
      evidence: [byCarrier ? scan(id, arrivalMs) : arrived(id, arrivalMs)],
      uptime: [],
      now: at(arrivalMs + HOUR),
    };
  });
}

/** A refund is something a bank tells you about, so coverage is never in question. */
function lateRefundCases(): BreachCase[] {
  const deadline = 7 * DAY;
  const owed = usd(40);
  const make = (
    id: string,
    label: "broken" | "kept",
    note: string,
    evidence: Evidence[],
    nowMs: number,
  ): BreachCase => ({
    id,
    target: "late_refund",
    label,
    observable: true,
    note,
    promise: promise(id, "refund_sla", { deadline: at(deadline), amount_at_stake: owed }),
    evidence,
    uptime: [],
    now: at(nowMs),
  });

  return [
    make(
      "refund_01",
      "broken",
      "refund landed 1 day late",
      [refunded("refund_01", deadline + DAY, owed)],
      deadline + 2 * DAY,
    ),
    make(
      "refund_02",
      "broken",
      "refund landed 3 days late",
      [refunded("refund_02", deadline + 3 * DAY, owed)],
      deadline + 4 * DAY,
    ),
    make(
      "refund_03",
      "broken",
      "refund landed 7 days late",
      [refunded("refund_03", deadline + 7 * DAY, owed)],
      deadline + 8 * DAY,
    ),
    make("refund_04", "broken", "no refund 2 days past the deadline", [], deadline + 2 * DAY),
    make("refund_05", "broken", "no refund 10 days past the deadline", [], deadline + 10 * DAY),
    /**
     * Half the money, on time. A partial refund is not a refund, and a detector that
     * only asks whether *something* arrived cannot tell the difference.
     */
    make(
      "refund_06",
      "broken",
      "only half the money came back, and it came back on time",
      [refunded("refund_06", deadline - DAY, usd(20))],
      deadline + DAY,
    ),
    make(
      "refund_07",
      "kept",
      "refund landed 5 days early",
      [refunded("refund_07", deadline - 5 * DAY, owed)],
      deadline + DAY,
    ),
    make(
      "refund_08",
      "kept",
      "refund landed 1 day early",
      [refunded("refund_08", deadline - DAY, owed)],
      deadline + DAY,
    ),
    make(
      "refund_09",
      "kept",
      "refund landed exactly on the promised day",
      [refunded("refund_09", deadline, owed)],
      deadline + DAY,
    ),
    make(
      "refund_10",
      "kept",
      "still inside the refund window when it was assessed",
      [],
      deadline - 2 * DAY,
    ),
  ];
}

/** A price seen is a fact, not a sighting that could have been missed. */
function priceDropCases(): BreachCase[] {
  const window = span(0, 14 * DAY);
  const paid = usd(200);
  const make = (
    id: string,
    label: "broken" | "kept",
    note: string,
    evidence: Evidence[],
    nowMs = 15 * DAY,
  ): BreachCase => ({
    id,
    target: "price_drop",
    label,
    observable: true,
    note,
    promise: promise(id, "price_match", { window, amount_at_stake: paid }),
    evidence,
    uptime: [],
    now: at(nowMs),
  });

  return [
    make("price_01", "broken", "price fell by one cent inside the window", [
      priceSeen("price_01", 3 * DAY, { minor: 19999, currency: "USD" }),
    ]),
    make("price_02", "broken", "price fell by five dollars", [
      priceSeen("price_02", 3 * DAY, usd(195)),
    ]),
    make("price_03", "broken", "price fell by fifty dollars", [
      priceSeen("price_03", 9 * DAY, usd(150)),
    ]),
    make("price_04", "broken", "price fell by a hundred and twenty dollars", [
      priceSeen("price_04", 12 * DAY, usd(80)),
    ]),
    /** Two sightings, and the cheaper one is not the later one. */
    make("price_05", "broken", "price dipped then partly recovered; the dip is what counts", [
      priceSeen("price_05", 4 * DAY, usd(120)),
      priceSeen("price_05", 6 * DAY, usd(170)),
    ]),
    /**
     * Cheaper at the very instant the window closes. The window is half-open, so the
     * engine will not count it; a person reading "price match until the 14th" would.
     */
    make("price_06", "broken", "price fell at the exact instant the window closed", [
      priceSeen("price_06", 14 * DAY, usd(150)),
    ]),
    make("price_07", "kept", "price only ever went up", [priceSeen("price_07", 5 * DAY, usd(215))]),
    make("price_08", "kept", "price matched exactly; a match is not a drop", [
      priceSeen("price_08", 4 * DAY, paid),
    ]),
    make(
      "price_09",
      "kept",
      "price fell two days after the window closed",
      [priceSeen("price_09", 16 * DAY, usd(150))],
      18 * DAY,
    ),
    make("price_10", "kept", "nobody ever saw another price", []),
  ];
}

/**
 * A delivery window that closed. Four hours, so 168 watched minutes is coverage of
 * exactly 0.7 — the knife edge, where both gates are met to the digit.
 */
function missedWindowCases(): BreachCase[] {
  const window = span(4 * HOUR, 8 * HOUR);
  const WINDOW_MINUTES = 240;

  const settledByCarrier = (
    id: string,
    lateMinutes: number,
    label: "broken" | "kept",
  ): BreachCase => {
    const arrival = 8 * HOUR + lateMinutes * MINUTE;
    return {
      id,
      target: "missed_window",
      label,
      observable: true,
      note:
        lateMinutes > 0
          ? `carrier scanned it ${lateMinutes} minutes after the window closed`
          : lateMinutes === 0
            ? "carrier scanned it at the exact instant the window closed"
            : `carrier scanned it ${Math.abs(lateMinutes)} minutes before the window closed`,
      promise: promise(id, "delivery_window", { window, amount_at_stake: usd(30) }),
      // The door saw the drop too, so the phantom reading stays out of the way.
      evidence: [scan(id, arrival), atDoor(id, arrival, "package_placed")],
      uptime: [watching(3 * HOUR, Math.max(arrival, 9 * HOUR) + HOUR)],
      now: at(Math.max(arrival, 9 * HOUR) + 2 * HOUR),
    };
  };

  const nothingCame = (
    id: string,
    watchedMinutes: number,
    label: "broken" | "kept",
  ): BreachCase => ({
    id,
    target: "missed_window",
    label,
    observable: watchedMinutes / WINDOW_MINUTES >= 0.7,
    note: `nothing arrived; the door was watched for ${watchedMinutes} of ${WINDOW_MINUTES} minutes`,
    promise: promise(id, "delivery_window", { window, amount_at_stake: usd(30) }),
    evidence: [],
    uptime: [watching(4 * HOUR, 4 * HOUR + watchedMinutes * MINUTE)],
    now: at(10 * HOUR),
  });

  return [
    settledByCarrier("window_01", 1, "broken"),
    settledByCarrier("window_02", 45, "broken"),
    settledByCarrier("window_03", 300, "broken"),
    nothingCame("window_04", 240, "broken"),
    /** Exactly 0.7 coverage: both gates met to the digit. */
    nothingCame("window_05", 168, "broken"),
    settledByCarrier("window_06", -200, "kept"),
    settledByCarrier("window_07", -1, "kept"),
    /**
     * Arrived at the exact instant the window closed. The interval is half-open, so the
     * engine reads that as late; a household promised "by five" would not.
     */
    settledByCarrier("window_08", 0, "kept"),
    /** One minute of watching short of the gate. */
    nothingCame("window_09", 167, "broken"),
    nothingCame("window_10", 36, "broken"),
  ];
}

/**
 * Scanned delivered, with nobody at the door.
 *
 * Every scan lands inside the window so the missed-window reading is Kept and the
 * phantom reading is the one that speaks. The evaluated hour is the scan plus or minus
 * thirty minutes, so 42 watched minutes is coverage of exactly 0.7.
 */
function phantomDeliveryCases(): BreachCase[] {
  const window = span(4 * HOUR, 8 * HOUR);
  const scanAt = 6 * HOUR;
  const from = scanAt - 30 * MINUTE;

  const nobodyCame = (id: string, watchedMinutes: number): BreachCase => ({
    id,
    target: "phantom_delivery",
    label: "broken",
    observable: watchedMinutes / 60 >= 0.7,
    note: `scanned delivered; ${watchedMinutes} of the 60 minutes around the scan were watched and nobody came`,
    promise: promise(id, "delivery_window", { window, amount_at_stake: usd(30) }),
    evidence: [scan(id, scanAt)],
    uptime: [watching(from, from + watchedMinutes * MINUTE)],
    now: at(10 * HOUR),
  });

  const somebodyCame = (
    id: string,
    offsetMinutes: number,
    event: "package_placed" | "person_detected",
    note: string,
  ): BreachCase => ({
    id,
    target: "phantom_delivery",
    label: "kept",
    observable: true,
    note,
    promise: promise(id, "delivery_window", { window, amount_at_stake: usd(30) }),
    evidence: [scan(id, scanAt), atDoor(id, scanAt + offsetMinutes * MINUTE, event)],
    uptime: [watching(from, from + 90 * MINUTE)],
    now: at(10 * HOUR),
  });

  return [
    nobodyCame("phantom_01", 60),
    nobodyCame("phantom_02", 54),
    nobodyCame("phantom_03", 44),
    /** Exactly 0.7 coverage. */
    nobodyCame("phantom_04", 42),
    somebodyCame(
      "phantom_05",
      0,
      "package_placed",
      "scanned delivered and the door saw the parcel go down",
    ),
    somebodyCame(
      "phantom_06",
      29,
      "person_detected",
      "somebody was at the door 29 minutes after the scan",
    ),
    /**
     * The parcel was demonstrably placed — one minute outside the tolerance the
     * detector looks in. The household got their parcel; the engine cannot see it.
     */
    somebodyCame(
      "phantom_07",
      31,
      "package_placed",
      "the parcel went down 31 minutes after the scan, just outside the tolerance",
    ),
    /** One minute of watching short of the gate. */
    nobodyCame("phantom_08", 41),
    nobodyCame("phantom_09", 20),
    nobodyCame("phantom_10", 6),
  ];
}

/**
 * An appointment slot nobody turned up for.
 *
 * Two detectors speak here and they ask different questions over different windows.
 * `no_show` judges the slot with thirty minutes of tolerance either side — 180 minutes
 * — while `missed_window` judges the two-hour slot itself. Watching placed inside the
 * slot therefore counts for more against the narrower window, and a first draft of this
 * corpus had a case it believed was starved sitting at 0.79 coverage on the reading that
 * actually won. The watching below is placed to starve both, so `observable` means the
 * same thing whichever detector speaks.
 */
function noShowCases(): BreachCase[] {
  const slot = span(5 * HOUR, 7 * HOUR);
  const SLOT_MINUTES = 120;
  const JUDGED_MINUTES = 180;

  /** Minutes watched before the slot, inside it, and after it. */
  const nobodyCame = (id: string, before: number, inside: number, after: number): BreachCase => {
    const total = before + inside + after;
    const uptime = [
      ...(before > 0 ? [watching(5 * HOUR - before * MINUTE, 5 * HOUR)] : []),
      ...(inside > 0 ? [watching(5 * HOUR, 5 * HOUR + inside * MINUTE)] : []),
      ...(after > 0 ? [watching(7 * HOUR, 7 * HOUR + after * MINUTE)] : []),
    ];
    return {
      id,
      target: "no_show",
      label: "broken",
      // Starved on both readings, or claimable on both. Never one of each.
      observable: total / JUDGED_MINUTES >= 0.7 || inside / SLOT_MINUTES >= 0.7,
      note: `nobody came; the door was watched for ${total} of the ${JUDGED_MINUTES} minutes judged`,
      promise: promise(id, "appointment_slot", { window: slot, amount_at_stake: usd(25) }),
      evidence: [],
      uptime,
      now: at(9 * HOUR),
    };
  };

  const somebodyCame = (id: string, arrivalMs: number, note: string): BreachCase => ({
    id,
    target: "no_show",
    label: "kept",
    observable: true,
    note,
    promise: promise(id, "appointment_slot", { window: slot, amount_at_stake: usd(25) }),
    evidence: [atDoor(id, arrivalMs, "person_detected")],
    uptime: [watching(4.5 * HOUR, 7.5 * HOUR)],
    now: at(9 * HOUR),
  });

  return [
    nobodyCame("noshow_01", 30, 120, 30),
    nobodyCame("noshow_02", 30, 105, 0),
    /** Exactly 0.7 of the judged window, and only 0.55 of the slot. */
    nobodyCame("noshow_03", 30, 66, 30),
    somebodyCame("noshow_04", 5 * HOUR + MINUTE, "arrived a minute into the slot"),
    somebodyCame("noshow_05", 6 * HOUR, "arrived in the middle of the slot"),
    somebodyCame("noshow_06", 7 * HOUR - MINUTE, "arrived with a minute of the slot left"),
    /**
     * Turned up 29 minutes early. Inside the tolerance the detector evaluates, outside
     * the slot itself — and nobody would call that a no-show.
     */
    somebodyCame(
      "noshow_07",
      5 * HOUR - 29 * MINUTE,
      "turned up 29 minutes before the slot opened",
    ),
    /** One minute of watching short of the gate, on both readings. */
    nobodyCame("noshow_08", 30, 65, 30),
    nobodyCame("noshow_09", 30, 24, 0),
    nobodyCame("noshow_10", 0, 18, 0),
  ];
}

/**
 * The corpus: sixty scripted timelines, ten per breach kind.
 *
 * Deterministic and pinned to a committed file by a test, so it cannot be widened,
 * narrowed or reordered after somebody has seen a disappointing number.
 */
export function generateBreachCorpus(): BreachCase[] {
  seq = 0;
  return [
    ...lateEtaCases(),
    ...missedWindowCases(),
    ...phantomDeliveryCases(),
    ...noShowCases(),
    ...lateRefundCases(),
    ...priceDropCases(),
  ];
}

export const CORPUS_PARAMETERS = {
  cases_per_kind: 10,
  kinds: ["late_eta", "missed_window", "phantom_delivery", "no_show", "late_refund", "price_drop"],
  /** H2's threshold: precision is measured on cases at or above this coverage. */
  observable_coverage_min: 0.7,
} as const;
