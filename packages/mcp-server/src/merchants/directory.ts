import type { Money } from "@owed/domain";
import type { Respondent } from "@owed/recourse-protocol";

export interface StatedRemedy {
  stated: Money;
  clause_title: string;
}

/**
 * Where merchant agents are found.
 *
 * A port, so the same `claim_file` runs against in-process agents in tests and against
 * agents over HTTP in the demo — where the inspector can see the exchange.
 */
export interface MerchantDirectory {
  respondentFor(merchant: string, remedy: StatedRemedy): Respondent | undefined;
}
