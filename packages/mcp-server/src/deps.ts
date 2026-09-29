import type { Clock, EventStore, IdGen } from "@owed/core";
import type { Currency } from "@owed/domain";
import type { MerchantDirectory } from "./merchants/directory.js";

/** Everything the tools need, passed in rather than reached for (plan §6.2). */
export interface OwedDeps {
  store: EventStore;
  clock: Clock;
  householdId: string;
  currency: Currency;
  /** Shared with the seed, so live event ids continue past the seeded ones. */
  idGen: IdGen;
  merchants: MerchantDirectory;
}
