import type { BreachKind } from "@owed/policy-library";

/**
 * How a merchant argues.
 *
 * Every parameter is independent and none of them is tuned against our negotiator —
 * that is what makes the grid built from them a pre-registration rather than a
 * flattering sample.
 */
export interface MerchantBehaviour {
  /** First offer as a fraction of the figure the merchant published. 0 offers nothing. */
  anchor_ratio: number;
  /** How much of the gap to the household's counter they close each round. */
  concession_rate: number;
  /** They settle when the counter is at or below this multiple of their stated remedy. */
  accept_ratio: number;
  /** Refuse outright on this reply. 0 means they never refuse. */
  declines_at_round: number;
  /**
   * Adversarial: countering costs you the offer.
   *
   * Without merchants like this, every cell in the evaluation is a win or a tie for
   * the negotiator, which is exactly what makes a self-refereed benchmark worthless.
   */
  withdraws_on_counter: boolean;
}

export interface MerchantConfig {
  merchant: string;
  behaviour: MerchantBehaviour;
  /**
   * Overrides per breach kind, because merchants genuinely differ by claim type: a
   * price match is mechanical and settles instantly, a late refund is contested.
   */
  by_breach_kind?: Partial<Record<BreachKind, Partial<MerchantBehaviour>>>;
  escalation_route?: string;
}

export const COOPERATIVE: MerchantBehaviour = {
  anchor_ratio: 1,
  concession_rate: 0.6,
  accept_ratio: 1.2,
  declines_at_round: 0,
  withdraws_on_counter: false,
};

export const STINGY: MerchantBehaviour = {
  anchor_ratio: 0.4,
  concession_rate: 0.3,
  accept_ratio: 1,
  declines_at_round: 0,
  withdraws_on_counter: false,
};

export const STONEWALLING: MerchantBehaviour = {
  anchor_ratio: 0,
  concession_rate: 0,
  accept_ratio: 0.5,
  declines_at_round: 1,
  withdraws_on_counter: false,
};

export function behaviourFor(config: MerchantConfig, breachKind: BreachKind): MerchantBehaviour {
  return { ...config.behaviour, ...(config.by_breach_kind?.[breachKind] ?? {}) };
}
