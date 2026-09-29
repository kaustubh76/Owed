import { createMerchantAgent, storyboardMerchant } from "@owed/merchant-agents";
import type { Respondent } from "@owed/recourse-protocol";
import type { MerchantDirectory, StatedRemedy } from "./directory.js";

/** Agents in this process. Deterministic, and what the tests use. */
export function inProcessMerchants(): MerchantDirectory {
  return {
    respondentFor(merchant: string, remedy: StatedRemedy): Respondent | undefined {
      const config = storyboardMerchant(merchant);
      if (config === undefined) return undefined;
      return createMerchantAgent({ config, lookup: () => remedy });
    },
  };
}
