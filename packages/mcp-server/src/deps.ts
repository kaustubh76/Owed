import type { Clock, EventStore } from "@owed/core";
import type { Currency } from "@owed/domain";

/** Everything the tools need, passed in rather than reached for (plan §6.2). */
export interface OwedDeps {
  store: EventStore;
  clock: Clock;
  householdId: string;
  currency: Currency;
}
