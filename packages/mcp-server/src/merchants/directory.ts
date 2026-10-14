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
  /**
   * Release whatever the directory is holding.
   *
   * Optional because the in-process implementation holds nothing — it answers from
   * objects in this process and has nothing to hang up. The HTTP one keeps a live MCP
   * client per merchant, and `shutdown()` used to leave every one of them open.
   */
  close?(): Promise<void>;
}
