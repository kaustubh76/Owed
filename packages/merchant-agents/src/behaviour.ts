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

/**
 * Randomness, structurally — `@owed/core`'s `Rng` satisfies this without this package
 * depending on core, the same way `MerchantPrior` satisfies `CounterExperience`.
 */
export interface Randomness {
  next(): number;
}

/**
 * How much a merchant's conduct wanders from its configuration.
 *
 * The evaluation's headline caveat, in `eval/README.md`, is that these merchants are
 * deterministic — so "the negotiator reaches the oracle" is partly a property of the
 * simulation rather than a claim about the algorithm. `Rng` and `SeededRng` were written
 * for exactly this, with the comment "injected so merchant-agent behaviour is
 * reproducible", and then nothing injected one.
 *
 * `jitter` is a fraction: 0.2 means each of the three continuous parameters is multiplied
 * by something in [0.8, 1.2], drawn once per agent so a merchant is inconsistent between
 * claims and consistent within one. A merchant that changed its mind mid-argument would
 * be a different thing — noise rather than variation.
 *
 * `declines_at_round` and `withdraws_on_counter` are deliberately left alone. They are
 * discrete, and moving them would change how much of the grid is adversarial or
 * unwinnable, which is a pre-registered property of the grid rather than a property of
 * any one merchant's temperament.
 */
/** The three continuous parameters. The discrete two are never varied. */
export const VARIABLE_PARAMETERS = ["anchor_ratio", "concession_rate", "accept_ratio"] as const;
export type VariableParameter = (typeof VARIABLE_PARAMETERS)[number];

export interface Variability {
  rng: Randomness;
  jitter: number;
  /**
   * Which of the three to wobble. All of them by default.
   *
   * Varying them one at a time is how a result gets attributed rather than just observed:
   * the first run of this showed arguing losing to taking the first offer under any
   * jitter, and the question that mattered was immediately *which* parameter did it.
   */
  parameters?: readonly VariableParameter[];
}

/** Non-negative, because every one of these is a ratio. */
function wobble(value: number, { rng, jitter }: Variability): number {
  return Math.max(0, value * (1 + (rng.next() * 2 - 1) * jitter));
}

/** Draw one merchant's temperament. Called once per agent, never per reply. */
export function varyBehaviour(
  behaviour: MerchantBehaviour,
  variability: Variability,
): MerchantBehaviour {
  const chosen = new Set(variability.parameters ?? VARIABLE_PARAMETERS);
  const varied = { ...behaviour };
  // Every parameter is drawn for, chosen or not, so that which ones are varied does not
  // change the sequence the others get — otherwise two passes would differ for two
  // reasons at once and neither could be attributed.
  for (const parameter of VARIABLE_PARAMETERS) {
    const drawn = wobble(behaviour[parameter], variability);
    if (chosen.has(parameter)) varied[parameter] = drawn;
  }
  return varied;
}
