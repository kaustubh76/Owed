import type { BreachKind, MerchantPolicy, Money, PolicyClause, Remedy } from "./schema.js";

export interface RemedyContext {
  /** The order value, for proportional remedies. */
  amount_at_stake?: Money;
  /** How far a price fell, for difference remedies. */
  shortfall?: Money;
}

/**
 * What a clause entitles the household to.
 *
 * `reservation` is the merchant's stated figure — the point below which an offer is
 * worse than their own published promise. `ceiling` is the most that promise can be
 * read to allow, and is the highest the negotiator may ever ask for.
 */
export interface ResolvedRemedy {
  clause: PolicyClause;
  reservation: Money;
  ceiling: Money;
}

const zero = (currency: string): Money => ({ minor: 0, currency });

function scale(amount: Money, fraction: number): Money {
  return { minor: Math.round(amount.minor * fraction), currency: amount.currency };
}

function lower(a: Money, b: Money): Money {
  return a.minor <= b.minor ? a : b;
}

function higher(a: Money, b: Money): Money {
  return a.minor >= b.minor ? a : b;
}

function amountsFor(
  remedy: Remedy,
  context: RemedyContext,
): { reservation: Money; ceiling: Money } | undefined {
  if (remedy.kind === "fixed") {
    return { reservation: remedy.stated, ceiling: remedy.ceiling };
  }

  if (remedy.kind === "proportional") {
    const stake = context.amount_at_stake;
    if (stake === undefined) return undefined;
    const share = scale(stake, remedy.fraction);
    const withFloor = remedy.floor === undefined ? share : higher(share, remedy.floor);
    return { reservation: lower(withFloor, remedy.ceiling), ceiling: remedy.ceiling };
  }

  // difference: the household is owed exactly what it lost, and no more.
  const shortfall = context.shortfall;
  if (shortfall === undefined) return undefined;
  const owed = lower(shortfall, remedy.ceiling);
  return { reservation: owed, ceiling: owed };
}

/**
 * Resolve the remedy a merchant's own policy gives for a breach.
 *
 * Returns `undefined` when the merchant has published nothing covering it. That is the
 * honest answer, and the negotiator treats it as "no claim to make" rather than
 * inventing a figure.
 */
export function remedyFor(
  policy: MerchantPolicy,
  breachKind: BreachKind,
  context: RemedyContext = {},
): ResolvedRemedy | undefined {
  const candidates = policy.clauses.filter((clause) => clause.breach_kinds.includes(breachKind));

  let best: ResolvedRemedy | undefined;
  for (const clause of candidates) {
    const amounts = amountsFor(clause.remedy, context);
    if (amounts === undefined) continue;

    const resolved: ResolvedRemedy = {
      clause,
      reservation: amounts.reservation,
      // A ceiling below the stated figure would let the negotiator ask for less than
      // the merchant promised, which is the wrong failure to have.
      ceiling: higher(amounts.ceiling, amounts.reservation),
    };
    // Where more than one clause applies, the household gets the better of them.
    if (best === undefined || resolved.reservation.minor > best.reservation.minor) best = resolved;
  }

  return best;
}

/** Nothing owed, in the policy's own currency — used when no clause applies. */
export function nothingOwed(policy: MerchantPolicy): Money {
  return zero(policy.currency);
}

export function findClause(policy: MerchantPolicy, id: string): PolicyClause | undefined {
  return policy.clauses.find((clause) => clause.id === id);
}
