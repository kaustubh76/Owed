# @owed/policy-library

**What a merchant has already promised you, as data you can argue from.**

Apache-2.0. Part of [Owed](../../readme.md), and useful on its own.

---

## The idea

Every merchant publishes a remedy somewhere — a delivery guarantee, a refund window, a
price promise — and then relies on nobody reading it. This library turns those documents
into resolvable rules, so an agent arguing on a household's behalf can cite the merchant's
own clause rather than an opinion about what seems fair.

That is the whole design constraint: **a claim is only ever as strong as the clause it
points at.** Nothing here invents a figure. If a merchant has published nothing covering
a breach, `remedyFor` returns `undefined`, and the honest answer is to say so rather than
to make one up.

```ts
import { builtinPolicies, remedyFor } from "@owed/policy-library";

const policy = builtinPolicies().get("Northwind Parcel");
const remedy = remedyFor(policy, "missed_window");

remedy.reservation;    // { minor: 800,  currency: "USD" }  — what they said they owe
remedy.ceiling;        // { minor: 1000, currency: "USD" }  — the most that clause allows
remedy.clause.title;   // "Delivery Guarantee 4.1"
remedy.clause.quote;
// "If your parcel arrives outside the window we gave you, we credit $8, or up to $10
//  where the delay exceeds two hours."
```

## Reservation and ceiling, and why both

A negotiator needs two numbers, and conflating them is how automated claims become either
greedy or useless.

- **`reservation`** is the merchant's own stated figure. It is the floor: settling below
  it means the household lost money the merchant had already agreed they were owed.
- **`ceiling`** is the most that clause can be read to allow, and the highest the
  negotiator may ever ask for. Opening there is not a bluff, because the wording permits
  it.

Owed opens at the ceiling, counters by citing the clause, and never settles below the
reservation without saying so out loud.

## Three remedy shapes

A remedy is rarely a flat number, so a clause resolves against context:

| `remedy.kind` | Meaning | Needs |
|---|---|---|
| `fixed` | A stated amount, and a ceiling the wording allows | — |
| `proportional` | A share of what was at stake, with an optional floor and a ceiling | `amount_at_stake` |
| `difference` | Exactly what was lost, capped — what a price promise owes | `shortfall` |

Context is supplied by the caller (`{ amount_at_stake, shortfall }`), so the library stays
pure: it resolves rules, it never goes looking for facts. A `difference` clause with no
`shortfall` in context resolves to nothing rather than to zero.

## Provenance is required, not optional

Every clause **must** carry a `source` and a `quote`, because Owed's central claim is that
it asserts only what a merchant itself promised, and that claim rests entirely on these
files being faithful transcriptions. A clause without its source is hearsay, and the
schema rejects it.

The merchants here are fictional and their policies are written out in full as prose in
[`docs/policies/`](../../docs/policies/), so the chain is complete: a card says *"they owe
you eight dollars"* → a clause id → a quoted sentence → a document a person could read.

## Adding a merchant

One JSON file, validated by `MerchantPolicySchema` on load. A malformed policy is
rejected outright, never partially trusted.

```jsonc
{
  "merchant": "Northwind Parcel",
  "currency": "USD",
  "retrieved_at": "2026-09-20T00:00:00Z",
  "clauses": [
    {
      "id": "northwind/delivery-guarantee#4.1",
      "title": "Delivery Guarantee 4.1",
      "breach_kinds": ["missed_window"],
      "source": "Northwind Parcel Delivery Guarantee, clause 4.1 (docs/policies/northwind-parcel.md)",
      "quote": "If your parcel arrives outside the window we gave you, we credit $8, or up to $10 where the delay exceeds two hours.",
      "remedy": { "kind": "fixed", "stated": { "minor": 800, "currency": "USD" }, "ceiling": { "minor": 1000, "currency": "USD" } }
    }
  ]
}
```

The six breach kinds — `late_eta`, `missed_window`, `phantom_delivery`, `no_show`,
`late_refund`, `price_drop` — are redeclared here rather than imported, so the library
does not drag a claimant's domain model along with it and interoperates structurally.

## What this is not

It is not legal advice, and none of these merchants exist. A real deployment would need
policies transcribed from real published terms, dated and auditable — which is why
`retrieved_at` exists and why `source` and `quote` are mandatory. A remedy nobody can
trace to a source is exactly the kind of claim this library exists to avoid making.
