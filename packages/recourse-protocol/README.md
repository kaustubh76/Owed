# Recourse protocol v1

Agent-to-agent dispute resolution between a household's agent and a merchant's agent.

A household is owed something a merchant promised — a delivery window, an arrival time, a
refund by a date, a price match. Today that claim is settled by a person waiting on hold.
This protocol lets two agents settle it directly, in seconds, against the merchant's own
published policy.

Apache-2.0. Five messages. No dependency on the claimant's codebase.

---

## The exchange

```
claimant  ──CLAIM──▶   merchant      a promise, the evidence, the clause relied on, the ask
          ◀─OFFER───                 what the merchant will pay
          ──COUNTER─▶                a higher figure, citing the merchant's own clause
          ◀─SETTLE──                 agreed
                                     …or
          ◀─DECLINE─                 refused, with somewhere for the household to go
```

Three rounds by default. A round is one merchant reply, so `CLAIM → OFFER → COUNTER →
SETTLE` is **two rounds**.

## The five messages

| Message | From | Carries |
|---|---|---|
| `CLAIM` | claimant | `promise`, `breach_kind`, `evidence_pack`, `policy_ref?`, `ask` |
| `OFFER` | merchant | `amount`, `form` (`credit` / `refund` / `reship`), `terms?` |
| `COUNTER` | claimant | `amount`, `justification` (clause + evidence ids + coverage statement) |
| `SETTLE` | merchant | `amount`, `form`, `reference?` |
| `DECLINE` | merchant | `reason`, `escalation_route` |

Every message carries the `claim_id` it belongs to, so a transcript cannot be spliced.

## Four obligations

1. **Evidence is sent once.** The `CLAIM` carries the pack; everything after it references
   `id`s. A merchant is not handed the household's material again on every round.
2. **A `DECLINE` must carry an escalation route.** Refusing is allowed. Leaving a household
   with nowhere to go is not — and the schema enforces it, including against blank strings.
3. **A merchant never opens a claim and never counters.** `OFFER`, `SETTLE`, `DECLINE`.
4. **Sessions terminate.** Within the round cap, or by a terminal message.

## The evidence pack, and why coverage is in it

```jsonc
{
  "items": [{ "id": "evd_1", "kind": "carrier_scan", "captured_at": "…" }],
  "coverage": 0.82,
  "evaluation_interval": { "start": "…", "end": "…" }
}
```

`coverage` is the fraction of `evaluation_interval` that some source was actually observing.
It is part of the protocol because a claim that says *"we watched 82% of the hour around your
scan and saw nobody"* is a different proposition from one that says *"we watched 20%"* — and
a merchant is entitled to know which it is being asked to pay for.

## Implementing a merchant agent

```ts
import { checkMerchantConformance, type Respondent } from "@owed/recourse-protocol";

const agent: Respondent = {
  name: "northwind",
  respond(transcript) {
    const claim = transcript[0];
    return {
      type: "OFFER",
      claim_id: claim.claim_id,
      at: new Date().toISOString(),
      amount: { minor: 500, currency: "USD" },
      form: "credit",
    };
  },
};

const report = await checkMerchantConformance(agent);
// report.passed === true
```

`checkMerchantConformance` tests the obligations the specification imposes, not any
particular negotiating stance. **A merchant that declines every claim is fully conformant.**

## Validating from another language

The JSON Schema is generated from the same definitions this package validates with, so the
specification and the code cannot drift:

```ts
import { recourseJsonSchema } from "@owed/recourse-protocol";
```

## Running a session

```ts
import { runSession } from "@owed/recourse-protocol";

const result = await runSession(claimant, merchant, { maxRounds: 3 });
// result.outcome: "settled" | "escalated"
// result.rounds:  merchant replies
```

`runSession` is the enforcement point: it validates every message, checks the claim id holds
across the transcript, and rejects a merchant that says something only a claimant may say.
It takes an injected clock, so a transcript is byte-identical on every run.

Replies are awaited, because any merchant worth implementing this for is across a network.
An in-process implementation just returns a value and costs nothing extra.
