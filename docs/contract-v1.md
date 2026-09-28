# Owed — frozen v1 contract

> **Frozen 2026-09-28 (D0).** Everything downstream references this file. Changing anything
> here requires a migration note and a golden-test update. Tool signatures in particular are
> locked: Alexa+ locks them at certification, and our storyboard test asserts against them.

---

## 1. Enumerations

**Promise kinds (7)**
`delivery_window` · `eta` · `refund_sla` · `appointment_slot` · `guarantee` · `price_match` · `warranty`

**Breach kinds (6)**
`late_eta` · `missed_window` · `phantom_delivery` · `no_show` · `late_refund` · `price_drop`

**Evidence kinds (6)**
`timestamp` · `carrier_scan` · `doorbell_event` · `doorbell_snapshot` · `refund_observed` ·
`price_observed`

> **Amended D5, while building the breach engine.** `price_observed` is added. `price_drop`
> is a frozen breach kind, but none of the original five evidence kinds could carry a price,
> so the detector had no input to reason over. Adding the evidence kind is the honest fix;
> the alternative was smuggling prices through `timestamp` labels.

**Promise status**
`Candidate → Captured → Watching → {Kept | Suspected | Breached} → Filed → Negotiating → {Settled | Escalated} → {Recovered | WrittenOff}`

**Ledger events (12)**
`PromiseCaptured` · `EvidenceObserved` · `SourceUptimeRecorded` · `PromiseAssessed` ·
`ClaimProposed` · `ClaimFiled` · `OfferReceived` · `CounterSent` · `Settled` · `Escalated` ·
`Recovered` · `WrittenOff`

> **Amended again, when negotiations became real.** `ClaimProposed` gains `expected` — the
> figure the merchant published — alongside `ask`, which is the opening position. Open money
> is totalled from `expected`. Once the ask is the policy *ceiling*, totalling from it would
> report a Meridian claim as $5 owed when their published remedy is $3, which is exactly the
> overstatement this product exists not to make. `Settled` additionally carries the session's
> own `rounds`, because a transcript cannot distinguish a merchant's settlement from one
> recorded when the household accepted an offer.

> **Amended D0, during implementation.** Two changes from the eleven events in `readme.md`:
> `SourceUptimeRecorded` is added, because uptime must be replayable independently of the
> observations inside it (§2); and `BreachDetected` becomes `PromiseAssessed`, carrying a
> verdict of `Kept` / `Suspected` / `Breached` / `Undetermined`, so one event covers every
> outcome of the breach engine instead of needing a separate event per verdict.

---

## 2. Decision thresholds

| Rule | Value |
|---|---|
| `Breached` requires | `confidence >= 0.85` **and** `coverage >= 0.70` |
| Otherwise, past deadline | `Suspected` — surfaced with what was and was not seen, never auto-filed |
| Claim filing | requires a recorded user confirmation; no auto-file in v1 |
| Negotiation rounds | max 3 |
| Ask ceiling | `ask <= policy.max_remedy(breach_kind, amount_at_stake)` at **every** round |
| `Recovered` | only when a credit/refund is *observed*, never when promised |

### Coverage is computed over a breach-kind-specific evaluation interval

`coverage = |union(uptime_intervals) ∩ evaluationInterval| / |evaluationInterval|`

| Breach kind | `evaluationInterval` |
|---|---|
| `missed_window` | the promise window |
| `phantom_delivery` | `carrier_scan.at ± 30 min` |
| `no_show` | appointment slot `± 30 min` |
| `late_eta`, `late_refund` | clock-derived; coverage is `1.0` (no observation gap is possible) |
| `price_drop` | the price-match window |

Evidence sources report **uptime intervals** (what was watched) separately from
**observations** (what happened inside them). This is what lets the system express
*"the camera was up and saw nothing"* — the phantom-delivery signal.

Some detectors read a **complete log** rather than a gappy observation. A carrier's own
scan record and the household's own bank credits have no gaps to have missed anything in,
so those detectors report coverage `1`. Only camera-based judgements carry a fraction.

### Confidence

Where a verdict rests on *not having seen something*, confidence follows from coverage:

```
confidence = 1 − (1 − coverage) × 0.5
```

Read as: a real event would have to fall inside the unobserved fraction to explain the
absence of any sighting, and roughly half of a gap is a plausible hiding place. That gives
**0.91 at 82% coverage** and **0.60 at 20%** — enough to act on when the camera was mostly
up, and visibly not enough when it was not. If the claimed moment *itself* fell inside a
gap, confidence is further multiplied by 0.6, because the absence of a sighting then says
much less however good the surrounding coverage looks.

Every verdict in the seeded week is **computed by this engine**, not authored, and every
negotiation is **argued out against a merchant agent** over that merchant's own published
policy. The storyboard states only what was observed and when a claim was filed; the
figures, the verdicts and the transcripts are all outcomes.

---

## 3. Tool surface (6 tools, `snake_case`, frozen)

| Tool | Input | Output | View |
|---|---|---|---|
| `ledger_summary` | `{ period?: "week" \| "month" }` | `{ recovered, open, kept, items[] }` | `ui://owed/ledger` |
| `promises_list` | `{ status?, merchant? }` | `{ promises[] }` | `ui://owed/ledger` |
| `promise_check` | `{ promise_id }` | `{ status, breach?, coverage, evidence[] }` | `ui://owed/evidence` |
| `claim_file` | `{ promise_id, confirm?, attach_evidence? }` | `{ claim_id, state, offer?, settled? }` | `ui://owed/claim` |
| `claim_status` | `{ claim_id }` | `{ state, rounds[], amount? }` | `ui://owed/claim` |
| `evidence_get` | `{ evidence_id }` | `{ kind, uri, captured_at, coverage }` | `ui://owed/evidence` |

**Every result carries exactly one text content block** — self-sufficient, spoken-quality,
no markdown, no URLs, ≤ 240 characters. Plus `structuredContent`, plus `_meta.ui` on both the
tool definition and the result.

`claim_file` takes an explicit `confirm` **and** elicits when the client declares the
capability. Elicitation is the preferred branch, never the only one — Alexa+ does not
document which modes it supports.

**Views:** `ui://owed/ledger` · `ui://owed/claim` · `ui://owed/evidence`

---

## 4. Recourse protocol v1

```
CLAIM    { claim_id, promise, evidence_pack{items[], coverage}, policy_ref, ask }
OFFER    { claim_id, amount, form: credit|refund|reship, terms }
COUNTER  { claim_id, amount, justification{policy_clause, evidence_ids[]} }
SETTLE   { claim_id, amount, form, reference }
DECLINE  { claim_id, reason, escalation_route }
```

Max 3 rounds. Every message carries the claim id. Evidence is referenced, never re-sent.
A `DECLINE` must carry a human escalation route.

---

## 5. Money

All amounts are a typed `Money` value object: integer **minor units** plus an ISO-4217
`currency`. The demo runs in **USD**. Never a bare number, never a float.

---

## 6. The storyboard — exact figures, asserted by the golden test

Household `hh_demo`, week of **Mon 2026-10-05 → Sun 2026-10-11**, `America/Los_Angeles`.
Merchants are fictional: **Northwind Parcel**, **Meridian Rides**, **Calder & Co.**,
**Alder Home Services**.

### The hero claim — phantom delivery

| | |
|---|---|
| Promise | Northwind Parcel, `delivery_window` Tue 12:00–16:00, order value **$68.40** |
| Evidence | `carrier_scan` "delivered" at **14:12**; doorbell uptime 13:42–14:42 **minus a gap 13:51–14:02** |
| Coverage | 49 min observed of a 60 min evaluation interval = **0.82** — and 14:12 itself *was* watched |
| Confidence | **0.91** |
| Policy | Northwind *Delivery Guarantee §4.2* — `max_remedy` **$15.00**, `stated_remedy` **$12.00** |
| Exchange | `CLAIM` ask **$15.00** → `OFFER` **$5.00** → `COUNTER` **$12.00** (§4.2, coverage stated) → `SETTLE` **$12.00** |
| Rounds | **2** |
| Recovered | Wed 10:05, when the credit is observed |

### The week

| # | Day | Merchant | Kind | Outcome | Amount |
|---|---|---|---|---|---|
| 1 | Mon | Meridian Rides | `late_eta` | Settled → Recovered | $3.00 |
| 2 | Tue | Northwind Parcel | `phantom_delivery` | Settled → Recovered (Wed) | $12.00 |
| 3 | Wed | Alder Home Services | `no_show` | Settled → Recovered | $9.00 |
| 4 | Thu | Calder & Co. | `late_refund` (day 11 of 5–7) | **Escalated** — open | $5.00 |
| 5 | Fri | Calder & Co. | `price_drop` ($89.99 → $74.99) | Settled → Recovered | $15.00 |
| 6 | Sat | Northwind Parcel | `missed_window` | Settled → Recovered | $8.00 |
| 7 | Sun | Meridian Rides | `late_eta` | Filed, negotiating — open | $3.00 |
| 8 | Thu | Northwind Parcel | — | **Kept** (delivered in window) | — |
| 9 | Fri | Alder Home Services | — | **Kept** (on time) | — |
| 10 | Sun | Northwind Parcel | `phantom_delivery`? | **Suspected — declined to file** | — |

Item 10 is the trust beat: carrier scan "delivered 16:40", doorbell uptime only 16:20–16:32,
so coverage over the `16:10–17:10` evaluation interval is **0.20** — below the 0.70 gate.
Owed says so instead of claiming.

### Headline numbers (the golden test asserts these exactly)

- **Recovered this week: $47.00** (3.00 + 12.00 + 9.00 + 15.00 + 8.00)
- **Open: $8.00** (5.00 escalated + 3.00 negotiating)
- **Kept: 2**
- **Declined to file: 1**, at coverage 0.20

### Spoken lines

- **Tue 18:40, proactive (Echo Show):** *"Your Northwind parcel was scanned delivered at 2:12 this afternoon. Nobody came to the door between 1:42 and 2:42. Want me to file it?"*
- **After settlement:** *"Settled for twelve dollars in two rounds, under Northwind's own delivery guarantee."*
- **Sun 19:30, "Alexa, what am I owed?":** *"You've recovered forty-seven dollars this week, and eight dollars is still open. Two promises were kept. There's one I'm not claiming — I only watched twenty percent of the window."*
