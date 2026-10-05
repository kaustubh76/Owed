# Merchant agents

Reference implementations of the merchant side of the
[recourse protocol](../recourse-protocol), served over MCP.

A household's agent files a claim; something has to answer it. This package is that
something — a merchant agent that reads a `CLAIM`, looks up what its own published policy
says it owes, and argues its corner according to a declared behaviour. One tool,
`recourse_respond`, and a merchant is reachable by any claimant that speaks the
specification.

Apache-2.0. Depends on `@owed/recourse-protocol` and `@owed/policy-library`, and on nothing
in the household's codebase.

---

## Why this exists as a package

Two reasons, and the second is the one that matters.

**So the protocol has a second implementation.** A wire format with one implementation is a
data structure. The claimant in `@owed/mcp-server` and the respondents here were written
against the specification rather than against each other, which is the only way to find out
whether the specification says enough.

**So the evaluation cannot flatter the negotiator.** These agents are the opponent in
`@owed/eval`'s recourse benchmark. If the thing being measured and the thing doing the
measuring share assumptions, the number is worthless. So the behaviour space here was
**fixed before the negotiator was tuned against it**, and it includes merchants designed to
beat it — see `withdraws_on_counter` below.

## The behaviour model

A merchant is five independent numbers. None is tuned against our negotiator.

| Parameter | What it controls |
|---|---|
| `anchor_ratio` | First offer as a fraction of the figure the merchant published. `0` offers nothing. |
| `concession_rate` | How much of the gap to the household's counter they close each round. |
| `accept_ratio` | They settle when the counter is at or below this multiple of their stated remedy. |
| `declines_at_round` | Refuse outright on this reply. `0` means they never refuse. |
| `withdraws_on_counter` | **Adversarial: countering costs you the offer.** |

That last one is the point of the whole file. Without merchants who punish argument, every
cell in the evaluation is a win or a tie for the negotiator — which is exactly what makes a
self-refereed benchmark meaningless. A negotiator that always counters should lose money
against these, and if it does not, the measurement is broken rather than the result being
good.

```ts
import { GRID_PARAMETERS, GRID_SIZE, behaviourId } from "@owed/merchant-agents";

GRID_SIZE; // 270 — the full cross product, not a sample
```

The whole grid is run rather than a subset. These are pure functions costing microseconds,
so there is no reason to report a sample and every reason not to. `behaviourId()` gives each
cell a stable name, so a result traces back to the exact policy that produced it.

### Named presets

`COOPERATIVE`, `STINGY` and `STONEWALLING` for the common postures, and
`STORYBOARD_MERCHANTS` for the four in Owed's seeded week: Northwind Parcel, Meridian Rides,
Alder Home Services and Calder & Co.

Calder & Co. is configured **per breach kind**, because that is what is actually true of
merchants: its price promise is mechanical and settles on request, while its refund timing is
contested. One agent, two postures.

## Serving them

```ts
import { createMerchantAgentsApp, merchantSlug } from "@owed/merchant-agents";

createMerchantAgentsApp().listen(3941, "127.0.0.1");
```

Each merchant is a separate MCP server on its own path, so a claimant connects to one
merchant and sees only that merchant:

```
GET  /merchants                 the directory: name and path for each
ALL  /mcp/:slug                 one MCP endpoint per merchant
```

`/merchants` exists so a claimant can discover the roster without hard-coding slugs, and
`merchantSlug()` is exported so both sides derive the same path from the same name.

Or run the binary, which is what `pnpm demo` does:

```bash
pnpm --filter @owed/merchant-agents start   # OWED_MERCHANTS_PORT, default 3941
```

It binds `127.0.0.1` only. Nothing here is intended to face a network.

## Building your own

`createMerchantAgent` takes a `MerchantConfig` and a `RemedyLookup`:

```ts
import { COOPERATIVE, createMerchantAgent } from "@owed/merchant-agents";

const agent = createMerchantAgent({
  config: { merchant: "Your Co.", behaviour: COOPERATIVE, escalation_route: "support" },
  lookup: (breachKind, claim) => ({ stated: yourRemedy(breachKind), clause_title: "§4.1" }),
  clock: (step) => instantForStep(step),   // optional; see below
});
```

`lookup` is the only part that is genuinely yours: it answers "what does our own published
policy say we owe for this?". Everything else is the protocol.

`clock` takes the step number and returns the instant for it, rather than reading the wall
clock, because a negotiation transcript is an artifact that gets compared — in a golden test,
in the protocol inspector, between two runs of the evaluation. A timestamp from `Date.now()`
would make every transcript unique and none of them comparable. It is optional; supply it
whenever the transcript needs to be reproducible.

## What this is not

**Not a simulation of any real company.** The four named merchants are fictional, and the
behaviours are parameter choices rather than observations of anyone's conduct.

**Not the protocol.** That is [`@owed/recourse-protocol`](../recourse-protocol) — five
messages, four obligations, no dependency on either side's codebase. This package is one
implementation of one side of it.
