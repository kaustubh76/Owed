import type { LedgerPeriod, PromiseKind, PromiseStatus } from "@owed/domain";

export const KIND_LABEL: Readonly<Record<PromiseKind, string>> = {
  delivery_window: "delivery window",
  eta: "arrival time",
  refund_sla: "refund",
  appointment_slot: "appointment",
  guarantee: "guarantee",
  price_match: "price match",
  warranty: "warranty",
};

export const STATUS_LABEL: Readonly<Record<PromiseStatus, string>> = {
  Candidate: "not yet tracked",
  Captured: "captured",
  Watching: "watching",
  Kept: "kept",
  Suspected: "not claiming",
  Breached: "ready to file",
  Filed: "filed",
  Negotiating: "negotiating",
  Settled: "settled, waiting on the credit",
  Escalated: "escalated",
  Recovered: "recovered",
  WrittenOff: "written off",
};

export const PERIOD_LABEL: Readonly<Record<LedgerPeriod, string>> = {
  week: "this week",
  month: "this month",
};

/** Items worth a household's attention: what is still moving, then what landed. */
const STATUS_PRIORITY: Readonly<Record<PromiseStatus, number>> = {
  Escalated: 0,
  Negotiating: 1,
  Filed: 2,
  Breached: 3,
  Settled: 4,
  Recovered: 5,
  Suspected: 6,
  Kept: 7,
  Watching: 8,
  Captured: 9,
  Candidate: 10,
  WrittenOff: 11,
};

export function byAttention(a: PromiseStatus, b: PromiseStatus): number {
  return STATUS_PRIORITY[a] - STATUS_PRIORITY[b];
}
