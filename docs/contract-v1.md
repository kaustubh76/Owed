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

> **Amended D20 — two of the seven promise kinds had no detector.** `guarantee` and
> `warranty` were extractable from the day this froze, and `eval/results/extraction.json`
> publishes precision and recall for both, but `appliesTo` covered five kinds. They were read
> out of a merchant's words, written to the ledger, and never judged: `assessPromise` returned
> nothing and `promise_check` answered "I'm still watching", which was false and permanent.
>
> Both are covered now by a seventh detector, `derivedBreach`, and **the six breach kinds
> stay six**. A guarantee has no evidence of its own — there is no doorbell event for "or your
> money back" — so it inherits the verdict, breach kind, coverage and evidence ids of a
> promise read from the same merchant message. A guarantee over a missed delivery window *is*
> a `missed_window`; what the guarantee adds is the clause to argue from, which the negotiator
> was already citing. `claim_file` resolves a derived promise to the claim its message already
> has, so one failure stays one claim.
>
> `EvidenceView` gains one optional field, `watched`, `false` when nothing in the ledger will
> ever reach a verdict on that promise. The card and the spoken line both render it through
> `evidenceStance`, which is asserted over every stance by
> `packages/mcp-server/src/voice.stance.test.ts` — the only place both renderers can be
> reached from.
>
> **Corrected the same day it was written.** This paragraph first said `watched` was `false`
> only where no detector covers the promise, and that the card and the spoken line read the
> one field. Both halves were wrong. `watchable` asks the registry's `appliesTo`, which
> receives the promise and not the ledger, so `derivedBreach` matches `warranty` on kind alone
> and then abstains forever when there is no sibling — leaving "Covered for 24 months under
> our manufacturer warranty." a **tracked** promise at 0.95 that nothing judged and that
> `promise_check` described as "I'm still watching the Northwind Parcel warranty". And the
> card was never wired to the field at all: it went on rendering `VERDICT_LABEL`'s
> `Undetermined` — "still watching" — for exactly that promise.
>
> So `watched` is answered from ledger state, not from the kind: a derived promise is watched
> only when its own message holds a promise that can be judged on its own terms. Two
> warranties in one message are correctly both unwatched.

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

| Tool | Input | Output (`outputSchema`) | View |
|---|---|---|---|
| `ledger_summary` | `{ period?: "week" \| "month" }` | `LedgerSummaryView` | `ui://owed/ledger` |
| `promises_list` | `{ status?, merchant? }` | `LedgerSummaryView`, filtered | `ui://owed/ledger` |
| `promise_check` | `{ promise_id }` | `EvidenceView` | `ui://owed/evidence` |
| `claim_file` | `{ promise_id, confirm?, attach_evidence? }` | `ClaimView` | `ui://owed/claim` |
| `claim_status` | `{ claim_id }` | `ClaimView` | `ui://owed/claim` |
| `evidence_get` | `{ evidence_id, promise_id }` | `EvidenceView` | `ui://owed/evidence` |

Three view schemas, not six output shapes, and each is declared as the tool's `outputSchema`
so a client validates against it:

| schema | fields |
|---|---|
| `LedgerSummaryView` | `currency`, `recovered`, `open`, `kept`, `declined`, `items`, `period`, `as_of` |
| `ClaimView` | `claim_id`, `promise_id`, `merchant`, `state`, `ask`, `expected`, `settled_amount`, `recovered_amount`, `rounds`, `round_count` |
| `EvidenceView` | `promise_id`, `merchant`, `kind`, `status`, `verdict`, `coverage`, `evaluation_interval`, `gaps`, `promised_in`, `explanation`, `watched`, `items` |

**Amended D18.** This table was wrong in two ways, and it is the table everything else
references, so the correction is recorded rather than quietly applied. `evidence_get` was
listed as taking `{ evidence_id }` alone; it requires `promise_id` too, because an evidence
id does not say whose promise it belongs to — `readme.md` §4 fixed that in its own copy of
the table and this one was missed. And the output column described five shapes that do not
exist: `promise_check` was given a `breach?` and an `evidence[]` it has never had, and
`claim_file` an `offer?` and `settled?`. A reader following the old column would have
validated against fields the server does not send.

**Every result carries exactly one text content block** — self-sufficient, spoken-quality,
no markdown, no URLs, ≤ 240 characters. Plus `structuredContent`, plus `_meta.ui` on both the
tool definition and the result.

`claim_file` takes an explicit `confirm` **and** elicits when the client declares the
capability. Elicitation is the preferred branch, never the only one — Alexa+ does not
document which modes it supports.

**Views:** `ui://owed/ledger` · `ui://owed/claim` · `ui://owed/evidence`

### Confirmation

`claim_file` asks before it files. Both of the questions the ideation names — *file it?* and
*attach the doorbell evidence?* — are asked in **one form-mode round** as flat booleans, which
is the whole of what MCP elicitation permits and spares a household being asked twice about
one claim.

Elicitation is used **only where the connection can carry it**: the 2026-07-28 revision, where
the request rides in the result, or a client that has declared the capability. Per-request
serving of the 2025 revision cannot make server-to-client requests at all, so there the tool
proposes in words and waits for `confirm`. Both paths are tested; see docs/friction-log.md §10.

### Measured against Amazon's documented targets

| Target | Documented | Measured |
|---|---|---|
| Tool round trip | under 500 ms | **all six tools**, 50 calls each over Streamable HTTP; distribution and the machine it was measured on in `eval/results/latency.json` |
| Text contrast | 4.5:1 (3:1 for large or bold) | gate fails on any violation and reports the tightest pass, in both themes; **worst passing 5.33:1**, on the recovered total on the light ledger card |
| Touch targets | 48×48 px | all controls pass |
| Spoken answer | self-sufficient, no digits, ≤ 240 chars | enforced on every result |

**What this does not establish.** Alexa+ for Builders is partner-gated, so none of it runs
against the real client. These assert the *documented* contract. "Contract suite green" is not
"works on Alexa+", and the submission should never imply otherwise.

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

**Ten here, eleven in the ledger.** `prm_011` is deliberately absent from this table: it is
the promise the demo files *during* the take, the one `readme.md` §5 traces as `clm_prm_011`
and the capture settles at $8.00. The ten above are the week as it stands when the recording
starts; the eleventh is what the household does next. The headline figures below count the
ten, which is why "Open: $8.00" does not include it.
Owed says so instead of claiming.

### Headline numbers (the golden test asserts these exactly)

- **Recovered this week: $47.00** (3.00 + 12.00 + 9.00 + 15.00 + 8.00)
- **Open: $8.00** (5.00 escalated + 3.00 negotiating)
- **Kept: 2**
- **Declined to file: 1**, at coverage 0.20

### Spoken lines

Transcribed from `docs/demo-capture.json`, which is a recording of the running server rather
than a draft of what it might say. `pnpm verify:ui` asserts the capture against what the
browser renders and against the headline figures above, so these cannot drift from the
product without the gate failing.

- **Sun 18:25, proactive (Echo Show):** *"Northwind Parcel missed the delivery window they promised. They owe you eight dollars under their own policy. Shall I file it?"*
- **After settlement:** *"Northwind Parcel settled at eight dollars in two rounds. I'll tell you when the credit lands."*
- **Sun 19:30, "Alexa, what am I owed?":** *"You've recovered forty-seven dollars this week, and eight dollars is still open. Two promises were kept. There's one I'm not claiming, because I only watched twenty percent of the window. There's one more I can file."*

**Amended D18.** All three were previously written by hand, and all three were sentences the
server cannot produce.

The first contained digits — *"scanned delivered at 2:12"*, *"between 1:42 and 2:42"* — and
`packages/mcp-server/src/voice.ts` forbids `/[0-9]/` outright ("numbers must be written the
way they are said"), with `assertSpeakable` wrapping every proactive line in
`proactive/scheduler.ts`. That sentence would have thrown rather than been spoken. It also
had no template behind it: announcements are
`<merchant> <phrase>. They owe you <money> under their own policy. Shall I file it?`, and the
beat it described does not fall on Tuesday evening.

The second matched no branch of `speakClaim`. The third dropped the fourth sentence —
*"There's one more I can file."* — which is the one that makes the ledger card an offer
rather than a report, and used an em-dash where the sentence says "because".

A document that freezes the contract should not be the place where the spoken surface is
imagined. These are now transcriptions.
