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

> **Amended D32 — the refusal named a gate it had not checked.** `Suspected` is returned when a
> broken promise fails **either** of the two gates above, and all three sentences that explained
> that refusal to a household read `coverage` and blamed the window:
>
> | where | what it said |
> |---|---|
> | `claim_file` | "I won't file that one. I only watched *N* percent of the window. That isn't enough to say it was broken." |
> | `ledger_summary` | "There's one I'm not claiming, **because** I only watched *N* percent of the window" |
> | `promise_check` | "I'm not claiming …. I watched *N* percent of the window. That isn't enough to be sure." |
>
> **It is reachable, which is what made this worth fixing rather than noting.** The confidence
> section above ends with the multiplier: if the claimed moment itself fell inside a gap,
> confidence is `confidenceFromCoverage(coverage) * 0.6`, which is **at most 0.6 whatever the
> coverage was**. So a doorbell camera up ninety-five percent of the window that happened to blink
> at the delivery moment fails the confidence gate alone — the exact case the 0.6 exists for — and
> Owed told the household *"I only watched ninety-five percent of the window. That isn't enough to
> say it was broken."* A sentence that contradicts itself, about money, out loud.
>
> **Why nobody noticed.** For a detection that saw the moment, confidence is
> `confidenceFromCoverage(coverage)` — and `confidenceFromCoverage(0.70)` is **exactly 0.85**. The
> two gates in the table above are calibrated to fail together, so for every case without the
> multiplier the coverage sentence was the true reason. Three independently chosen constants
> agreeing: nothing stated it, and `GAP_CREDIBILITY`'s own comment justifies 0.5 by what a gap can
> hide without mentioning the threshold it lands on. `breach.test.ts` now asserts the calibration,
> and the failure message names these sentences rather than the arithmetic.
>
> **`failedBreachGate(confidence, coverage)`** sits beside `meetsBreachGate` so the thresholds are
> compared in one place, and answers **coverage first** — so when both gates fail, which is the
> storyboard's twenty-percent promise and every case the demo reaches, every spoken line is
> byte-identical to before. This is a robustness fix, not a change of voice.
>
> **Two of the three needed a field.** `claim_file` holds the `Detection` and could just ask.
> `ledger_summary` and `promise_check` speak from views that carried `coverage` and not
> `confidence`, so both gained an optional `confidence` — the same move as §D21's `watched`, and
> for the same reason: the state existed and the sentence had no path to it. Populated from the
> assessment already in scope in both builders. `docs/demo-capture.json` was regenerated; the only
> things that moved are the new field, the three `ui://` bundle hashes that embed the schema, and
> the capture's own timestamp. Every spoken sentence in it is unchanged.
>
> Not fixed, and stated instead: `speakDeclined` still speaks for all declined promises using the
> one with the lowest coverage, so "there are three I'm not claiming, because …" gives one
> promise's reason for three. Defensible as the worst case; it is still one reason standing in for
> several.

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

> **Amended D26 — the views could call the tools, because the spec's default says they may.**
> MCP Apps lets a tool declare `_meta.ui.visibility`, listing who may call it: the model, a
> view, or both. Owed declared `resourceUri` on all six tools and `visibility` on none. The
> published default is **`["model", "app"]`** — the schema in `@modelcontextprotocol/ext-apps`
> says `Default: ["model", "app"]` in those words — so every tool was callable from inside a
> view, including `claim_file`, the one tool that argues with a merchant over HTTP and appends
> to the ledger. A view is sandboxed, opaque-origin HTML: the least trusted surface in this
> system had a path to the only irreversible one.
>
> **Why no test could see it.** Owed's own host cannot make that call. `apps/home/src/EchoShow.tsx`
> constructs its `AppBridge` with a null client, and the SDK only wires `oncalltool` when a
> client is present — so from inside this repository the permission was unobservable, and
> `pnpm verify:ui`, which drives all three views in a real browser, could never have tripped
> on it. It was found by connecting a **third party's** Alexa+ client, whose host implements
> the rule the spec actually states, and reading back what Owed advertises:
> `apps/brain/src/alexaPlusClient.test.ts`.
>
> **Now declared, narrowly.** All six tools carry `visibility: ["model"]` (`MODEL_ONLY` in
> `packages/mcp-server/src/views.ts`). Nothing is lost: the three views never call a tool —
> `ui-views/src/shared/useOwedView.ts` declares `capabilities: {}` and handles exactly
> `ontoolresult` and `onhostcontextchanged`. They are display surfaces, and the declaration now
> says so to any host rather than to this one.
>
> The general shape is the same as D25's: **what a platform permits by default is not what a
> server should advertise**, and an absence in a protocol is what a presence check cannot see.

### Confirmation

`claim_file` asks before it files. Both of the questions the ideation names — *file it?* and
*attach the doorbell evidence?* — are asked in **one form-mode round** as flat booleans, which
is the whole of what MCP elicitation permits and spares a household being asked twice about
one claim.

Elicitation is used **only where the connection can carry it**: the 2026-07-28 revision, where
the request rides in the result, or a client that has declared the capability. Per-request
serving of the 2025 revision cannot make server-to-client requests at all, so there the tool
proposes in words and waits for `confirm`. Both paths are tested; see docs/friction-log.md §10.

> **Amended D27 — the announcement asked, and the offer did not answer.** A
> `promise_breached` announcement speaks *"… Shall I file it?"* and carries an `offer` —
> `docs/proactive.md` calls it the field "without which an announcement is a dead end …
> what the household can say next, **and the tool it maps to**". Its arguments were
> `{ promise_id }`, which are the arguments that **propose**, not the ones that file. So the
> published offer did not perform what it offered: a host following it would ask a second
> time about a claim the household had just agreed to, and §3 above requires `claim_file` to
> ask before it files, not to ask twice. The offer now carries `confirm: true`, because the
> asking has already happened in the spoken line.
>
> Invisible because nothing used the field. The home rendered the offer as a button and then
> answered it with `speak(offer.utterance)` — the words — so the tool and the arguments had
> exactly one consumer between them, a `title` tooltip, and `scheduler.test.ts` asserted only
> that `arguments.promise_id` named the subject. The home now sends the offer itself
> (`OfferMessage` in `apps/brain/src/protocol.ts`), and the brain calls what it names after
> checking it against `tools/list`. Voice still goes through words and must: on an Echo Dot
> there is no button, and "file it" has to mean the thing just mentioned.
>
> **And Owed no longer announces back what the household just asked for.** Filing settles the
> claim, which makes a `claim_settled` commitment fall due, and the brain polls the instant a
> turn is broadcast — so the household heard *"Northwind Parcel settled at eight dollars. I'll
> tell you when the credit lands."* and was then told *"Northwind Parcel settled at eight
> dollars. I will tell you when the credit lands."* by an interruption, which carried its own
> card and replaced theirs. The poll still runs; events naming what the turn touched are marked
> seen and stay quiet (`apps/brain/src/proactive.ts`). `docs/proactive.md` opens on the premise
> this broke: *"Owed exists to notice what the household did **not** ask about."*

> **Amended D28 — the proposal argued for a field its own host ignored.** `docs/proactive.md`
> offers an eight-field commitment schema with a paragraph per field on why a host needs it.
> Counting *reads* rather than writes, seven had a consumer and `resource_uri` had **none** — the
> field whose stated purpose is "The card to render where there is a screen. Absent is
> legitimate: voice is enough." It was written in three places in `proactive/scheduler.ts` and
> drawn in the architecture diagram, which is exactly how it looked wired.
>
> The brain decided the card a second way: `cardCallFor` picked a tool from `event.kind`, and the
> card came from that tool result's `_meta.ui.resourceUri`. Two statements of "which card for
> this event" in two packages, agreeing only because both were written to agree — the state
> `schemas.sync.test.ts` exists to refuse everywhere else here. And the documented absence was
> not honoured: an event declaring no card still got one, because nothing looked.
>
> `announce()` now renders the card the event names, and `proactiveTurn.test.ts` asserts the two
> statements agree for every kind the storyboard produces — comparing the event to the tool
> result directly, not to the brain's own reader. The tool call stays unconditional, because it
> is what leaves the promise in focus and "file it" has to work on a device with no screen.
>
> **Gated, because the next field will look wired the same way.** `verify:docs` reads the field
> table out of `docs/proactive.md` and requires every field in it to be *read* somewhere in
> `packages/` or `apps/`. Writes deliberately do not count: proved by mutation — counting any
> mention reports `resource_uri 4` and passes while the host ignores it.

> **Amended D29 — the archive, which nothing had opened.** `verify:graph` checks that a
> publishable package declares `license`, `files` and `exports` and has a README, under a
> comment calling itself "the packaging half of the same claim". Three of those four are strings
> in `package.json`. All five publishable packages passed it while **shipping no `NOTICE`**, and
> three shipped compiled test files — `recourse-protocol` published `dist/protocol.test.js`,
> which imports `vitest`, a devDependency the archive does not depend on, under a `files` entry
> that said only `dist`.
>
> **What I claimed first and what packing showed.** I expected the archives to carry no licence
> text at all, since `LICENSE` and `NOTICE` existed only at the repository root. Packing one in
> its committed state refuted half of that: **pnpm 10.18.2 copies the workspace root's licence
> into a packed workspace package that has none**, so `LICENSE` was already there, byte-identical,
> by the packer's courtesy. `npm pack` performs no such substitution, and **nothing copies
> `NOTICE`** — which is the file Apache-2.0 §4(d) is about, and where this project's copyright
> holder and third-party notices live. Recording the correction rather than the first draft,
> because the difference between "no licence" and "a licence this packer happens to supply" is
> exactly the kind of thing this document exists to get right.
>
> Each of the five now carries `LICENSE` and `NOTICE` of its own, byte-identical to the root's
> and listed in `files`, and excludes `dist/**/*.test.*` and `dist/**/*.tsbuildinfo`.
>
> **Two gates, deliberately asymmetric.** `verify:graph` reads the file system: it catches a
> package losing its own copy, or a copy drifting from the root's. The new `pnpm verify:pack`
> builds the archive and reads what is in it: it catches what `files` actually resolves to, and
> an `exports` path no `files` entry ships. Neither subsumes the other, and the proof is a
> mutation of each — deleting a package's `LICENSE` is **invisible** to the archive gate, because
> pnpm supplies the root's again; dropping the `!dist/**/*.test.*` negation is **invisible** to
> the static gate, because `files` still reads as it did.

### Measured against the targets this submission holds itself to

This table used to be headed "Amazon's documented targets", and that overstated its
provenance. **There is not one `developer.amazon.com` citation in any file in this
repository** — every Amazon requirement here is uncited prose or an uncited code comment, and
three of the four thresholds below are figures the project chose. The *source* column says
where each number actually comes from, so a reader can discount the ones that are ours.

| Target | Threshold | Where the threshold comes from | Measured |
|---|---|---|---|
| Tool round trip | under 500 ms | **attributed to Amazon** — `alexa/contract.test.ts` says "Amazon documents a round-trip target under 500 ms", with no link; the constant is `TARGET_MS` in `eval/src/bin/latency.ts` | **all six tools**, 50 calls each over Streamable HTTP; distribution and the machine it was measured on in `eval/results/latency.json` |
| Text contrast | 4.5:1 (3:1 for large or bold) | **WCAG 2.x AA**, not Amazon — these are the web accessibility thresholds, in `scripts/verify-ui.mjs` | gate fails on any violation and reports the tightest pass, in both themes; **worst passing 5.33:1**, on the recovered total on the light ledger card, and `verify:ui` asserts this document quotes the figure it computed |
| Touch targets | 48×48 px | **ours** — a bare threshold in `scripts/verify-ui.mjs`, consistent with common platform guidance and cited to nothing | all controls pass |
| Spoken answer | self-sufficient, no digits, ≤ 240 chars | **ours** — `MAX_SPOKEN_CHARS` and the forbidden-pattern list in `packages/mcp-server/src/voice.ts`. What Amazon is quoted as requiring is narrower and unnumbered: "surface no API codes, tool names, JSON or internal IDs in any customer-facing response" | enforced on every result including refusals, and `verify:docs` holds the 240 above against the constant |

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

> **Amended D30 — the quantity still went unchecked, and that was the half D24 named.** D24's
> own first paragraph says `MoneySchema` leaves open "the currency ... or **the quantity** to be
> positive". Currency and sign were then both closed; magnitude was not, and `positive` is a
> weaker property than `sayable`.
>
> **What that cost.** `numberToWords` throws at a billion major units and `speakMoney` calls it,
> while `MoneySchema` accepts any safe integer and `formatMoney` has no ceiling at all. Nothing
> connected the limit on what Owed can *say* to the limit on what it will *accept*. So a
> merchant answering an $8.00 claim with `SETTLE { minor: 100000000000 }` was accepted, written
> to the append-only ledger, and folded into the recovered total — after which `voice.ts`, which
> speaks that **summed** total, raised `RangeError: numberToWords supports values below one
> billion` for every `ledger_summary` from then on. The card rendered `$1000000000.00`
> throughout, which is why nothing noticed: the two renderers disagreed and only one of them
> threw. D24's exact mechanism, D24's exact permanence, through D24's own guard.
>
> **Where the ceiling went, and why not beside the others.** `recourse-protocol` has no
> workspace dependencies and may not acquire one, so the limit cannot be imported there. It is
> Owed's own rule rather than the protocol's — `isSpeakable`, derived in `@owed/domain` from the
> one constant `numberToWords` throws on, and enforced in `@owed/core`'s `filing.ts` on **every**
> amount in the batch immediately before the append, because append-only is what made D24
> permanent and the offer, counter, observed credit and settlement all become rows. Guarding
> only the field somebody happened to think of is how the currency hole survived its own fix.
> It raises `UnspeakableAmount`, which `claim_file` routes exactly as it routes a
> `ProtocolViolation`: the claim is filed without the agent and the household hears the Owed
> sentence. A bare `RangeError` escaped that catch and became the spoken line.
>
> **The bound is not the ask, which was the obvious answer and is wrong.** A rule refusing any
> reply above `claim.ask` was written in `session.ts` first, and the pre-registered evaluation
> grid refused it: `reply names 1600 USD against an ask of 1500`. `accept_ratio` runs above 1 on
> purpose — a merchant whose published terms are more generous than the claimant's reading of
> them pays more than it asked for, and that is a merchant behaving well, not a peer lying. The
> claimant asks; it does not cap. `protocol.test.ts` now pins that a more generous reply is
> **accepted**, so the rule cannot be reintroduced quietly.
>
> **A `SETTLE` of nothing is a `DECLINE`.** The one relative rule that survived, and it needs
> only the claim: zero closed the claim as a settlement and was spoken as a recovery, while
> `DECLINE` is required to carry a reason *and* an escalation route, because a merchant may
> refuse but may not leave a household with nowhere to go. Settling at zero evaded both. Not
> applied to `OFFER` — a zero opening offer is ordinary haggling, and the grid runs
> `anchor_ratio: 0` deliberately to measure what the claimant does with one. The published
> suite needs no new check for it: `runSession` refuses the transcript before the suite could
> inspect a zero settlement, so a merchant author reads it off `reaches-a-conclusion`, which
> carries the violation's own sentence.

> **Amended D31 — two taps on "File it" filed the promise twice.** `claim_file` reads the ledger,
> checks whether this promise already has a claim, negotiates with the merchant, and only then
> appends. The check and the write are separated by the **whole negotiation** — up to three round
> trips to an agent across a network — so two calls arriving together both passed the check.
> Nothing serializes tool calls, and the store cannot catch it either: `#reserveSequenceBlock`
> hands concurrent appends **disjoint** sequence numbers, so `attribute_not_exists(sk)` keeps the
> log append-only and says nothing about logical uniqueness. Two taps on the home's chip reach it,
> as do two Echo devices and a brain retrying a call it believed had timed out.
>
> **What it was not.** I went looking for doubled money and there is none, which is worth writing
> down because the reason is not the obvious one. The claim id is derived from the promise, so a
> second filing is the *same* claim — and `ClaimProposed` is a **constructor, not a merge**:
> `state.claims.set(id, { …, rounds: [] })` rebuilds the claim, so the duplicate lifecycle
> overwrites the first instead of compounding it. Folding `Settled` and `Recovered` amounts into a
> running total — the plausible refactor, and how `summarize`'s own accumulator works — does *not*
> double the recovered figure, because the second `ClaimProposed` resets the field first. The
> change that *does* break it is making `ClaimProposed` preserve a claim it already has, the
> equally plausible "don't clobber": rounds then accumulate and one claim reads as two
> negotiations. Both were tried as mutations; only the second reddens, and
> `ledger/projections.test.ts` is now positioned on it rather than on the totals alone.
>
> **What it was.** The merchant was claimed against **twice for one promise in the same instant**,
> which is exactly the pile-on the frequency cap exists to prevent — and the cap counts distinct
> claims, so it never saw this. And the append-only ledger this submission offers as *evidence*
> held one claim's whole life twice, including two settlements of $8.00 for one $8.00 debt.
>
> **One shared in-flight filing**, the shape `apps/brain/src/session.ts` already uses for linking:
> N calls produce one, a joined caller gets the first call's outcome — the same claim the
> sequential path returns from its idempotency check — and the entry is cleared in `finally` so a
> failure is not cached. Entered only for a *confirmed* call, because an unconfirmed one asks a
> question and does no work, and handing a caller that passed `confirm: true` somebody else's
> "shall I?" would be a new bug.
>
> **Keyed by the store, after one wrong turn worth keeping.** The map began as a closure variable
> in `registerClaimFile`, which does nothing at all: `server.ts` says "a fresh server per request;
> all shared state lives in `deps`", and `app.ts` builds a new `{ ...deps, householdId }` literal
> every request, so neither the closure nor the `deps` identity survives between calls. The store
> is the object that does, and it is the thing being protected. A `WeakMap` on it, so a torn-down
> server takes its entry along and one test's harness cannot see another's.
>
> **Per process, which is the deployment that exists** — one `owed-server` unit per box. Two
> instances behind a load balancer would still race; the answer there is a conditional write on
> the *deterministic claim id* rather than on the sequence number, which the id scheme already
> allows and which nothing here implements. The same window also spans the
> `MAX_CLAIMS_PER_MERCHANT` cap — six concurrent filings against one merchant's six promises would
> each read a count below it — but demonstrating that needs two filable promises for one merchant
> and the seeded week has exactly one, so it is recorded as a limit rather than claimed as a
> defect.

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
>
> **And the same shape, found in the same pass.** `voice.ts` says of `assertSpeakable` that
> "this runs on every tool result rather than only in tests". Every `speak*` function on the
> success path was guarded and `spokenError` — the refusal path — was not, so a refusal was
> the one spoken line that could carry a digit, a URL, a tool name or JSON to a voice-only
> device, which is the thing `alexa/contract.test.ts` quotes Amazon forbidding verbatim. Most
> call sites pass a literal and were always safe; the three that compose a sentence from
> ledger state were a digit away. It had already happened once, in October, when a merchant's
> protocol violation reached the household as raw exception text. The guard now sits in
> `spokenError` itself, where the claim said it was, and `tools/context.test.ts` pins each of
> the four forbidden kinds.

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
