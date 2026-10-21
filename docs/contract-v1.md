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

> **Amended D21 — the state had no path to it.** `LedgerSummaryItem` gains the same optional
> `watched`. The card state and the spoken line above were correct and **unreachable from the
> simulated home**: `promise_check` is only ever called through the brain's focus, and focus
> was set from `Breached` and `Suspected` only. An unwatched promise is `Captured`, so no
> utterance and no chip could open it — a view state built, tested, and impossible to get to.
>
> The item carries the field because `status` alone cannot distinguish "nothing is watching
> this" from "its moment of judgement has not come"; the brain reads it off the ledger the
> household just asked for, keeps it in a third focus slot beside the two that existed, and
> answers "why aren't you watching that?" with it. `scripts/verify-ui.mjs` now drives that
> path in a browser — the first time that gate has touched `/control/*`, because the seeded
> week contains no promise it can reach the state with.

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

> **Amended D24 — a reply's money has to be money for this claim.** The three rules above are
> everything the protocol said about an inbound reply, and `MoneySchema` enforces only that an
> amount is three uppercase letters and an integer. Nothing required the currency to be the
> one the claim asked for, or the quantity to be positive, and nothing checked.
>
> **What that cost.** The negotiator accepts on `standing.amount.minor >= willSettleAt.minor`,
> comparing integers with no reference to the unit, so `SETTLE { minor: 1200, currency: "EUR" }`
> cleared a USD 12.00 reservation. The session recorded the merchant's amount verbatim,
> `fileClaim` wrote it into a `Settled` event, and the household was told "settled at twelve
> euros". Then `summarize` — which folds settlements into a `zeroMoney(currency)` accumulator
> whose `addMoney` throws on a mismatch — failed on the next read with `currency mismatch: USD
> vs EUR`. Both read tools project through `summarize`, and the ledger is **append-only**, so
> one reply from one merchant took `ledger_summary` and `promises_list` down permanently. A
> negative amount was accepted the same way and read worse: "settled at minus eight dollars",
> because `speakMoney` renders the sign.
>
> **Where the check went, and where it deliberately did not.** `session.ts` already refuses a
> message type a merchant may not send and a reply carrying a different claim id; this is the
> third check of the same kind, beside them, using the `sameCurrency` that has been in
> `messages.ts` since the protocol was written — whose only caller was
> `checkMerchantConformance`, which has no runtime caller at all. So the one currency check in
> the package ran only in tests. `MoneySchema` is **not** narrowed: the protocol is published
> and lifted out of this repository as it stands, and a receiver refusing what the wire format
> permits is Owed's policy, which belongs where the claim it is compared against is in scope.
>
> **A violation no longer loses the claim.** `store.append` runs after the whole negotiation,
> so a `ProtocolViolation` discarded everything before it — no `ClaimProposed`, no
> `ClaimFiled`, nothing in the ledger, and the raw exception message spoken to the household
> without ever passing `assertSpeakable`. That is the same failure `fileWithoutAgent` exists
> to prevent for a merchant that cannot be reached, so `claim_file` now routes a misbehaving
> merchant to the same place: the claim is filed on the `email` or `manual` route and the
> household is told the agent "answered with something I couldn't use".
>
> **And the handshake has a ceiling.** `respond` has always had one; the `connect` before it
> did not, so `initialize` fell back to the client SDK's 60s default and a merchant that
> accepted the connection and went quiet held `claim_file` for a minute before a single round.
> That also outlasted the brain's own untimed call, which gave up first and retried the whole
> tool call underneath — deduplicated only incidentally, by `claim_file` being idempotent per
> promise.
>
> None of this is reachable with the four reference agents: their MCP server declares
> `outputSchema: RespondentMessageSchema` and `createMerchantAgent` returns that type, so they
> are structurally honest. That is why eight conformance runs over real HTTP never saw it, and
> why the guard is tested through an injected directory in
> `tools/claimFileLyingAgent.test.ts`.

> **Amended D25 — the grant Alexa+ does not support was a way into the ledger.** The
> authorization server advertised `grant_types_supported: ["authorization_code",
> "refresh_token", "client_credentials"]` and implemented all three. Amazon's account-linking
> documentation says Alexa+ add-ons support **only** the Authorization Code Grant, and the
> published conformance checker only requires that `authorization_code` is *present* — so
> every extra grant was invisible to it, and `pnpm conformance` passed throughout.
>
> **What it could read.** `client_credentials` took a bare `client_id`, with no secret and no
> consent, and both registered clients are public PKCE clients whose ids are in the discovery
> document itself. It issued a token carrying `household_id: ""` and scope `mcp:service`, on
> the reasoning that a machine-to-machine token acts for no household. Then three things
> lined up: `/mcp` was mounted without `requiredScopes`, so the scope check was empty and
> `mcp:service` passed; the tool's dependencies were built as `householdFromAuth(...) ??
> deps.householdId`, so "no household" resolved to **the** household; and no test had ever
> driven a `client_credentials` token against a tool. One `curl` returned the recorded week —
> $47.00 recovered, $8.00 open, and every promise, merchant, claim id, amount and coverage.
> Confirmed by hand before anything was changed.
>
> **Removed, not wired**, which is the opposite of this repository's rule for orphans. The
> reasons are specific: the platform documents only the Authorization Code Grant, so this is
> alignment and not a lost feature; nothing here ever requested the grant; and an unused
> grant that hands out household-reading tokens is not an orphan waiting for a caller.
> `refresh_token` stays — implemented, tested, and what a client with a person at a consent
> screen would use.
>
> **Three defences now, because one was what failed.** The grant is gone from the metadata and
> the token endpoint. `/mcp` demands `owed.read`, which wires `requireOwedAuth`'s
> `403 insufficient_scope` branch — implemented since it was written and never once passed a
> `requiredScopes`, so it was dead code. And the household fallback distinguishes "auth is
> off, so there is no token" from "auth is on and the token named no household": the first
> keeps the configured household, because `startHarness({ auth: false })` and a local
> `pnpm demo` with auth off have no token at all and must still work; the second reads an
> empty ledger. Each is pinned by its own test in `auth/auth.test.ts` and each mutation
> reddens only that one.
>
> **What this says about the §10 row.** "Every tool call bound to a household id from the
> token" was marked as holding because the id is read from the token's claims and never from
> the request. That was true and incomplete: when the claim was empty it was read from
> *configuration*. `docs/requirements.md` now says so.

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

> **Amended D22 — a derived verdict is not a second event.** D20 gave `guarantee` and
> `warranty` a detector and D21 gave the state a path through the home. Both described data.
> This is the behaviour, and it had to be stated because the rest of the system counts
> promises in three places and two of them were wrong.
>
> A derived promise inherits its sibling's verdict, coverage and confidence — so when a
> delivery window breaks, the guarantee over it is `Breached` too, and `isActionable` is
> `verdict === "Breached"` and nothing more. The proactive channel therefore raised **two**
> announcements for one failure, and because `BREACH_SPOKEN` is keyed on the inherited breach
> kind the two spoken lines were word-for-word identical under two `event_id`s that nothing
> could dedupe. The second one also never stopped: filing sets the *window's* `claim_id`,
> which quiets its announcement, while the guarantee resolves to that same claim without one
> of its own — so it outlived the thing it was about. And `summarize` tallied both, reporting
> `kept: 2` for one kept promise and `declined: 2` for one declined, the second being the
> figure the demo's trust beat rests on.
>
> The rule, applied from `derivesFromSiblings` so there is no second list of kinds:
>
> **A derived promise is a real promise with a real verdict — it appears in the ledger's
> `items`, it answers `promise_check`, it draws its own card. It is not a separate event: no
> announcement of its own, no claim of its own, no line of its own in a tally.**
>
> Nothing is lost by it. A derived promise is `Breached` only because a sibling is, and that
> sibling is announced, claimed and counted.
>
> All three needed a *live* message to reproduce — the seeded week contains neither kind — which
> is why a suite that covers the live path well still missed them, and why the tests that hold
> this now post two promises in one message.

> **Amended D23 — and not a second claim, in either order.** D22 said a derived promise is
> not a separate event and fixed the three sites I had found. Looking for the rest turned up
> four more, one of which moved money, so the sites are enumerated here rather than left for
> the next reader to rediscover.
>
> **Filing could be defeated by order.** The dedup only recognised a derived promise when a
> claim *already existed*, so filing on the guarantee first created a claim against the
> guarantee, and the window — not being derived — then filed its own. `open` is summed over
> claims, so an $8 failure was reported as **$16**, reachable by asking about the guarantee
> and saying "file it", since the brain focuses any `Breached` promise. `claim_file` now
> **retargets** to the promise a derived one is about, before the idempotency check, the
> frequency cap and the remedy lookup — so there is one claim whichever of the pair is named,
> and the per-promise idempotency does the deduplication by itself.
>
> **The spoken counts offered to file it twice.** `speakReadyToFile` — the headline line — and
> `speakPromisesList` both counted every `Breached` item. They now skip derived kinds, and
> also skip promises that already have a claim: that second condition was missing all along,
> independent of derived verdicts, and meant any promise re-judged mid-negotiation read as
> filable again.
>
> **"I'm watching twelve promises" included one it says it is not watching.** The list count
> excludes `watched === false`, so the ledger and `promise_check` stop contradicting each
> other about the same promise.
>
> **And a claimed promise is no longer re-judged.** Promise status comes from the latest
> assessment, so new evidence overlapping a promise under negotiation rewound it to
> `Breached` — seen on the seeded `prm_007`, which the recorded week has mid-negotiation.
> Once a claim exists, the verdict that justified it is settled history and what happens next
> belongs to the claim's lifecycle.
>
> The rule is declared in one place now — `isDerivedKind` in `domain/src/promise.ts`, which
> `derivedBreach.appliesTo`, `derivesFromSiblings` and the voice all consult — and the places
> that count or act on a promise are: the proactive announcement loop, `summarize`'s `kept`
> and `declined`, `claim_file`, and the two spoken counts. That is the whole list.

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
