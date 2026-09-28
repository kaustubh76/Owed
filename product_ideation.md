# Owed
**An Alexa+ add-on that records every promise a business makes to your household, detects the breach, and collects what you're owed by negotiating with the merchant's agent.**
**Tagline:** Alexa+ has hundreds of add-ons that sell to you. This is the one that represents you.
**One-line explanation:** Owed turns the delivery windows, ETAs, refund SLAs and guarantees hidden in a household's receipts into enforceable promises, and recovers the money when they break — for any household that transacts through Alexa+, with zero extra effort.

---

### 1. Executive Summary

Every household transaction carries a promise: a four-hour delivery window, a five-minute cab ETA, a refund "within 5–7 days", a punctuality guarantee, a price match, a warranty. These promises are broken constantly, and the businesses making them price in the fact that almost nobody claims. Breakage is a line item. Consumers leave money on the table because the effort of claiming exceeds the value of any single claim — even though, aggregated across a year, the value is real. Package theft alone accounts for $8.2B a year in the US; "delivered but not received" is the single most common dispute, and 64% of victims end up chasing the retailer themselves.

Existing solutions fall short in three ways. Consumer-side tools (Paribus, DoNotPay, AirHelp) proved demand but live in a separate app the user must remember to visit; they never see the transaction at the moment the promise is made. Merchant-side tooling (support bots, claim portals) is built to minimise payout, not to represent the customer. And the voice assistant where household transactions increasingly happen — Alexa+ — treats every third-party add-on as a distribution channel for a brand; there is no add-on whose principal is the household.

Owed closes the loop: it captures the promise at the point of transaction (from receipts, confirmations and ETAs in a linked inbox), watches for the breach using evidence the household already produces (timestamps, carrier scans, doorbell events), and files and settles the claim agent-to-agent with the merchant's agent under an open recourse protocol. Every outcome lands in a ledger that the household can query by voice: "Alexa, what am I owed?"

**Objective.** Success is a demonstrable, measured recovery rate on realistic breach scenarios, delivered through a faithful Alexa+ add-on contract (MCP + MCP Apps + account linking) and a simulated household experience good enough that a judge believes it belongs on an Echo Show. Owed deliberately does **not** try to be a budgeting app, a subscription manager, a general assistant, or a legal service; it does one thing — enforce promises made to the household — and does it end-to-end.

### 2. The Central Question

**Can an agent that captures promises automatically from transaction records and negotiates claims with merchant agents recover a materially higher share of owed value — at ≥ 90% breach-detection precision — than the status quo of the household doing nothing or accepting the first offer?**

Measured as: (a) promise-extraction precision/recall on a labelled corpus, (b) breach-detection precision by breach type at a stated evidence-coverage threshold, (c) value recovered as a share of value owed across a matrix of merchant policies, versus the "accept first offer" and "do nothing" baselines.

### 3. Why the Name "Owed"?

The ledger has one headline number, and it is what the household is *owed*. The name is the invocation ("Alexa, what am I owed?"), the product's stance (the household is the creditor, not the supplicant), and the metric (recovered vs. open).

Limit of the metaphor: Owed is not a collections agency and not a lawyer. It enforces the merchant's *own* stated promises and policies with the merchant's *own* claim routes; it does not assert legal rights, threaten action, or pursue anything a merchant has not itself committed to.

### 4. Why This Matters Now

- **Alexa+ is becoming a transaction surface.** Amazon reports customers engage 6× more with services integrated into Alexa+, has added Amazon Wallet checkout for add-ons, and is onboarding ride, food, travel and ticketing brands over MCP. The promise is now made *in the conversation* — the first time a consumer agent could plausibly be present when it happens.
- **Merchant agents are arriving.** Merchants are shipping their own agents (this hackathon alone has AgentPOS putting merchant agents on Bedrock AgentCore). Agent-to-agent dispute resolution moves from speculative to inevitable; the side that defines the protocol first sets the norms.
- **Consumer trust is the bottleneck.** Public reviews of Alexa+ flag half-baked agentic tasks (wrong addresses, "that action isn't supported yet") and unreliable memory. Agentic commerce scales only if the customer has recourse when the agent's transaction goes wrong. Owed is the accountability layer Amazon's roadmap needs and has not built.
- **Timing window.** Add-on tooling is in private preview; the hackathon explicitly rewards a slick simulated experience "conceptually driven by an MCP". The idea can be proven now, ahead of general availability, and be ready when the toolkit opens.

### 5. Connection to Existing Solutions & Ideas

| Related work | What it does | Owed's extension |
|---|---|---|
| Paribus (acq. Capital One) | Price-drop and late-delivery refunds from email receipts | Same capture source; Owed generalises to all promise kinds and adds evidence and negotiation |
| DoNotPay | Templated consumer claims ("robot lawyer") | Owed replaces templates with agent-to-agent negotiation and lives where the transaction happens |
| AirHelp / Service | Flight-delay compensation | Domain-specific; Owed is a general promise ledger with a policy library |
| Ring / package-theft features | Detect delivery and theft events | Owed turns doorstep events into *evidence with coverage accounting* attached to a specific promise |
| AgentPOS (hackathon peer) | Merchant-side agentic checkout | Owed is the consumer-side counterpart and defines the recourse protocol merchant agents can implement |
| Alexa+ governance add-ons (Hirz, spend rules, verification harnesses) | Constrain what the agent may do | Orthogonal: Owed acts *after* a transaction, on the household's behalf |
| MCP elicitation, MCP Apps, OAuth 2.1 account linking | Platform primitives | Owed uses all three exactly as Alexa+'s client lifecycle documents them |

### 6. What Makes Owed Different?

| | Status quo (do it yourself) | Refund apps (Paribus-style) | Merchant support bots | Do nothing |
|---|---|---|---|---|
| Sees the promise when made | No — you must remember | Partially (email only) | Yes, but on the merchant's side | — |
| Evidence attached | Manual screenshots | None | Merchant's records only | — |
| Who negotiates | You, on hold | Nobody (fixed template) | Bot optimising for payout minimisation | — |
| Where it lives | Phone, laptop | Separate app | Merchant's app | — |
| Cross-session memory of outcomes | No | Per-app | No | — |
| Recovery rate | Low (effort-limited) | Narrow (price drops) | Whatever they offer | Zero |
| **Owed** | Captures automatically | All promise kinds + evidence | Negotiates agent-to-agent with policy citations | In the room, by voice, with a ledger |

The differentiated claim is not "voice interface for refunds." It is: *a consumer-side agent with evidence, a negotiation engine, and an open protocol, present where the promise is made.*

### 7. Core Mechanism / How It Works

**7.1 Input / Trigger**
- Transaction records from a linked inbox (OAuth-linked, read-only): order confirmations, ride receipts, appointment confirmations, refund acknowledgements, price/guarantee terms.
- Evidence streams: carrier scan timestamps, doorbell events and snapshots (Ring Partner API or emulator), refund/credit observations in the linked inbox, wall-clock.
- User utterances via Alexa+ (stand-in): "what am I owed?", "file it", "what came back?", "why?".

**7.2 Processing / Decision Logic**
- *Promise extraction:* each message → typed `Promise{kind, merchant, window/deadline, amount_at_stake, policy_ref, confidence}` via an LLM (Bedrock Nova 2 Lite) constrained to a JSON schema, followed by a deterministic rule pass for dates and amounts. Low-confidence promises are held as `Candidate` and not watched.
- *Breach detection:* `breach = f(promise, evidence[])` producing `{kind, confidence, coverage, evidence_ids, explanation}`.
  - `coverage` = observed fraction of the promise window across all evidence sources.
  - Decision rule: `Breached` only if `confidence ≥ 0.85` **and** `coverage ≥ 0.7`; otherwise `Suspected`, which surfaces to the user with what was and was not seen. Owed never files on a `Suspected` item without explicit user confirmation.
- *Claim decision:* expected value `EV = P(recover) × amount − effort_cost`; auto-propose when `EV > 0` and the merchant has a known recourse route in the policy library; otherwise present as an option.
- *Negotiation:* reservation value `r` from the policy library (the merchant's own stated remedy, e.g. delivery-guarantee credit); opening ask = `r × 1.2` capped by policy; concession schedule by merchant type; stop when `offer ≥ r` or rounds exhausted (default 3). Every counter cites a policy clause and evidence ids.

**7.3 Output / Action**
- Spoken outcome and an MCP Apps card on the device: ledger summary (recovered / open), claim timeline (offer → counter → settled), evidence card (coverage bar, snapshots, stated gaps).
- Claim filed through the merchant's agent (recourse protocol) or, where no agent exists, a templated email from the linked inbox with the evidence pack attached.
- Ledger event on every transition; "recovered" is marked only when the credit or refund is *observed*, never when it is promised.

**7.4 Feedback / Learning Loop**
- Outcomes update per-merchant priors: recovery rate, typical first offer, rounds to settle, escalation success. These feed the negotiator's reservation and concession schedule.
- Extraction and breach errors reported by the user ("that wasn't a promise", "the parcel did arrive") are logged as labelled examples and re-run through the eval harness before any prompt or rule change ships.

**7.5 Guardrails & Constraints**
- No claim is filed without a human "yes" (elicitation) in v1; an auto-file policy per merchant is a post-MVP opt-in.
- Owed asserts only what the merchant itself promised and only with evidence it can show; counters cite clauses, never threats.
- Rate limits: max one open negotiation per promise, max 3 rounds, cooldown before escalation.
- Evidence retention capped (30 days default); snapshots referenced by id, never re-sent to merchants beyond the initial pack.
- Read-only inbox scope; no sending except claim emails the user approved.

### 8. System Architecture (High-Level)

**Components**
- **Owed MCP server** (TypeScript, Streamable HTTP, MCP 2025-11-25): six tools, three `ui://` MCP Apps views, elicitation, OAuth 2.1 + PKCE account linking with RFC 9728/8414 discovery and RFC 7591 registration.
- **Core engines**: promise extractor, breach engine, negotiator, event-sourced ledger, recourse policy library.
- **Evidence adapters**: inbox (IMAP/Gmail API via OAuth), Ring Partner API webhook receiver (HMAC-verified) with an emulator fallback, carrier-scan parser.
- **Merchant agents**: three simulated MCP servers implementing the open recourse protocol with distinct policies.
- **Alexa+ stand-ins**: `mcp-voice-simulator` (lifecycle-faithful client, MCP Apps sandbox, conformance checker) and `alexa-skill-mcp-bridge` (real Echo via an Alexa Skill and a Strands agent on Bedrock AgentCore).
- **Simulated home** (React): Echo Show frame at Amazon's 768×480 canvas, Fire TV overlay, Echo Dot voice-only mode, phone rail, 7-day timeline scrubber, voice in/out, protocol inspector.

**Data flows**: inbox → extractor → ledger; evidence → breach engine → ledger; user turn → stand-in → MCP tools → ledger/negotiator → `_meta.ui` view → device; negotiator ↔ merchant agent over the recourse protocol.

**Key dependencies**: MCP TypeScript SDK 2.x and `@modelcontextprotocol/ext-apps`; Amazon Bedrock (Nova 2 Lite); DynamoDB (cloud) / SQLite (local); Ring Partner API (optional); the two community stand-ins.

**Separation of concerns**: all state and decisions live server-side; devices render views and relay voice; the stand-ins own orchestration only; merchant agents are independent processes.

**Observability**: the protocol inspector streams every JSON-RPC message and recourse exchange; the ledger is append-only and replayable to any instant (which is what the timeline scrubber does).

### 9. Key State / Data Model

- **Household** `{id, linked_sources[], policy_prefs}`
- **Promise** `{id, household_id, merchant, source_ref, kind ∈ {delivery_window, eta, refund_sla, appointment_slot, guarantee, price_match, warranty}, made_at, window|deadline, amount_at_stake, currency, policy_ref, confidence, status}`
  - Statuses: `Candidate → Captured → Watching → {Kept | Suspected | Breached} → Filed → Negotiating → {Settled | Escalated} → {Recovered | WrittenOff}`
- **Evidence** `{id, promise_id?, kind ∈ {timestamp, carrier_scan, doorbell_event, doorbell_snapshot, refund_observed}, captured_at, uri, coverage_contribution}`
- **Breach** `{id, promise_id, kind, confidence, coverage, evidence_ids[], explanation}`
- **Claim** `{id, promise_id, state, ask, rounds[] {type, amount, justification}, settled_amount?, route ∈ {agent, email, manual}}`
- **MerchantProfile** `{merchant, recourse_routes[], policy_clauses[], priors {recovery_rate, first_offer_ratio, median_rounds}}`
- **LedgerEvent** append-only: `PromiseCaptured, EvidenceAttached, BreachDetected, ClaimProposed, ClaimFiled, OfferReceived, CounterSent, Settled, Escalated, Recovered, WrittenOff`

Regimes: **Watching** (passive), **Acting** (negotiation open), **Degraded** (an evidence source is down — coverage cannot rise, so no new `Breached` states are entered).

### 10. Required Safety, Security & Reliability Properties

- **AuthN/AuthZ**: OAuth 2.1 + PKCE (S256) for Alexa+ account linking; Owed's own authorization server issues scoped tokens; inbox grant is read-only and separately revocable; every tool call is bound to a household id from the token.
- **Privacy & retention**: minimum data — promises and evidence pointers, not full mailboxes; snapshots retained 30 days; evidence shared with merchants only as the initial pack the user approved; no third-party analytics.
- **Failure modes**: evidence source down → `Degraded` regime, breach engine cannot escalate to `Breached`, user is told what is not being watched; merchant agent unreachable → claim falls back to email route with the same pack; Bedrock unavailable → extraction queues, ledger and tools stay readable.
- **Rate limits & abuse**: one negotiation per promise; 3-round cap; per-merchant claim frequency cap to avoid vexatious filing; no auto-file in v1.
- **Auditability**: append-only ledger; every claim message signed with claim id; the inspector renders the exact wire messages.
- **Dependency loss**: the add-on remains useful read-only (ledger, history) even if every external source is offline.

### 11. Risk & Threat Model

| Risk | Mitigation |
|---|---|
| False breach → wrongful claim harms merchant relationship | Coverage + confidence thresholds; `Suspected` never auto-files; user confirmation; explanation shown |
| Evidence misinterpretation (wrong door, neighbour's package) | Evidence tied to promise window and address; snapshots shown to user before filing |
| Inbox data leakage | Read-only scope, minimal extraction, seeded test inbox for demo, no raw mail stored |
| Merchant agents gaming the protocol (stalling, lowballing) | Round caps, reservation floors from policy library, escalation route mandatory on DECLINE |
| Prompt injection via receipts or merchant messages | Extraction constrained to schema; merchant messages parsed as protocol objects, never as instructions |
| Amazon builds this natively for Amazon orders | Merchant-agnostic positioning; Amazon orders are one source; protocol is open |
| Regulatory exposure (consumer-claims law) | Enforce only the merchant's own stated policies; no legal assertions; jurisdiction-neutral wording |
| Alexa+ contract changes at GA | Built to documented lifecycle; conformance checker in CI; tool signatures frozen |
| Solo-builder scope risk | Numbers first, UI second; cut order defined (bridge → Fire TV → phone rail) |

### 12. Honest Limitations

- Owed cannot run as a real Alexa+ add-on today; the toolkit is partner-gated. The Alexa+ orchestration, voice pipeline and proactive delivery are **simulated and labelled** as such.
- Merchant agents are simulated with three policies; no real merchant has adopted the recourse protocol.
- Extraction is evaluated on a seeded, labelled corpus, not on a live consumer mailbox.
- Doorbell evidence is real only if Ring Partner API access is granted; otherwise it runs on an emulator with scripted scenarios.
- Owed does not know legal entitlements; it enforces stated policies only.
- No claim of real money recovered for real users at this stage.

### 13. Validation & Experiment Plan

**Hypotheses**
- H1: Promise extraction reaches ≥ 0.9 precision and ≥ 0.8 recall across seven promise kinds on the labelled corpus.
- H2: Breach detection reaches ≥ 0.9 precision per breach type at coverage ≥ 0.7, with false-positive rate < 5% on "kept" scenarios.
- H3: The negotiator recovers ≥ 60% of owed value across the 20-policy matrix, ≥ 1.5× the "accept first offer" baseline, with median ≤ 2 rounds.
- H4: In a moderated walkthrough, 8 of 10 participants can state what Owed does and what it just did after the 90-second demo.

**Personas**: a two-adult household ordering online 3–5 times a week; a person managing an elderly parent's deliveries and appointments; a flat-share splitting rides and orders.

**Baselines**: do nothing; accept first offer; manual claim (time-cost estimate).

**Scenarios / test cases**: 60 scripted evidence timelines across `late_eta, missed_window, phantom_delivery, no_show, late_refund, price_drop`, including coverage gaps, kept promises, and ambiguous cases; 120 labelled promise messages; 20 merchant policies × 6 breach types for recourse.

**Metrics**: precision/recall (extraction, breach); recovery share, rounds, time-to-settle (recourse); p95 tool latency < 500 ms; qualitative comprehension in walkthroughs.

**Methods**: offline eval harnesses in CI; simulated household walkthroughs with 10 participants; one real-Echo run via the bridge.

**Kill / pivot triggers**: H1 or H2 below threshold after two iterations → the evidence story is not credible; pivot to a narrower scope (delivery-window and phantom-delivery only). H3 below baseline → drop negotiation, keep evidence-backed filing.

### 14. Development / Delivery Roadmap

- **Phase 0 — Freeze the concept (Sep 28–29).** Lock the seven promise kinds, six breach kinds, tool signatures, three views, recourse protocol v1. Write the labelled corpus and scenario set. Gate: this document approved; corpus committed.
- **Phase 1 — Core and numbers (to Oct 2).** Extractor, breach engine, ledger; MCP server with six tools; conformance passing. Gate: extraction and breach P/R reported in `eval/`; `ledger.summary` returns a card in the simulator.
- **Phase 2 — Recourse (to Oct 9).** Protocol spec, negotiator, three merchant agents, eval matrix; MCP Apps views at 768×480. Gate: recovery-rate number exists; claim card renders end-to-end.
- **Phase 3 — Simulated home (to Oct 16).** Surfaces, scrubber, voice, inspector, proactive badge; bridge deployed for one real-Echo shot. Gate: full 90-second storyboard runs without a cut.
- **Phase 4 — Ship (to Oct 22).** Video, README numbers, friction log, feature requests, open-source packages, reviewers added. Gate: submitted.

### 15. Suggested Timeline

| Date (IST) | Milestone |
|---|---|
| Sep 28–29 | Phase 0 freeze; corpus and scenarios committed |
| Oct 2 | Phase 1 gate — first numbers |
| Oct 9 | Phase 2 gate — recovery rate, claim card |
| Oct 12 | Walkthroughs with 10 participants begin |
| Oct 16 | Phase 3 gate — storyboard end-to-end; real-Echo shot recorded |
| Oct 19 | Video cut; README and eval results final |
| Oct 22 | Submit (deadline Oct 23 12:00 PDT = Oct 24 00:30 IST) |
| Nov 9–20 | Judging window — keep the demo deployment warm |

### 16. Recommended Team / Ownership Split

Solo build, so ownership is by phase with external review as the check:
- **Core engines and eval** — Kaushtubh. Reviewed by: a peer from Cipher running the eval harness cold from the README.
- **MCP server and protocol** — Kaushtubh. Reviewed by: the conformance checker in CI and one outside developer attempting to implement a merchant agent from the spec alone.
- **Simulated home and views** — Kaushtubh. Reviewed by: the 10-participant walkthrough; design checked against Amazon's design guide checklist.
- **Video, README, submission** — Kaushtubh. Reviewed by: one reader who has never seen the project scoring it against the four judging criteria.
Rule: nothing ships that only its author has run.

### 17. Demo / Pitch Script (under 3 minutes, judges may stop at 3:00)

- **0:00–0:20 Problem.** "Every order comes with a promise. Businesses break them and count on you not claiming. $8.2B in stolen packages alone last year; most people chase it themselves or give up."
- **0:20–0:40 Solution & differentiation.** "Owed is the Alexa+ add-on that works for the household. It records the promise where it's made, catches the breach with evidence, and settles with the merchant's agent."
- **0:40–2:10 Walkthrough.** Echo speaks first about the phantom delivery; two snapshots; "File it?" — yes; inspector shows `claim.file` and the recourse exchange; card: offer ₹50 → counter → settled ₹75 in 2 rounds; scrub to Thursday, Fire TV overlay on the late refund; scrub to Sunday, "Alexa, what am I owed?" — recovered ₹1,340; two seconds on an Echo Dot voice-only.
- **2:10–2:40 Evidence.** The three numbers: extraction P/R, breach precision at coverage ≥ 0.7, recovery share across 20 merchant policies vs baseline. Real-vs-simulated map on screen.
- **2:40–3:00 Close.** "Alexa+ has hundreds of add-ons that sell to you. This is the one that represents you. The recourse protocol is open — merchant agents can implement it today."

### 18. Likely Hard Questions

- *Isn't this just a refund app with a voice wrapper?* No — the differentiators are evidence with coverage accounting, agent-to-agent negotiation, and presence at the moment the promise is made. The numbers show recovery above the accept-first-offer baseline.
- *Why would merchants implement your protocol?* Because it is cheaper than call centres and disputes, and it caps their exposure at their own stated policy. The protocol is open and MCP-shaped; the first adopters are the ones already shipping agents.
- *Won't Amazon just build this?* For Amazon orders, perhaps. Owed is merchant-agnostic and consumer-side; Amazon benefits from trust in agentic commerce regardless of who builds the layer.
- *How much of this is real?* The MCP server, engines, protocol and evaluation are real; the Alexa+ orchestration, proactive delivery and merchant agents are simulated and labelled. See the real-vs-simulated map.
- *Privacy of the inbox?* Read-only, minimal extraction, no raw mail stored, demo runs on a seeded inbox.
- *What if the doorbell is wrong?* The engine never files below coverage 0.7; the user sees the snapshots and the stated gaps before confirming.
- *Legal exposure?* Owed asserts only the merchant's own stated promises and remedies; no legal claims.

### 19. Competitive Positioning

Related work is acknowledged: Paribus and DoNotPay on the consumer side; merchant support automation; the governance and verification add-ons in this hackathon; AgentPOS as the merchant-side peer. Owed's differentiated claim — **evidence-backed, agent-to-agent enforcement of promises, present where the transaction happens** — must be shown, not narrated: the inspector shows the wire, the eval shows the numbers, the card shows the money.

### 20. MVP Scope

**Must include**
- Seven promise kinds, six breach kinds; extractor and breach engine with published P/R.
- Owed MCP server: six tools, three views, elicitation, OAuth 2.1 + PKCE, conformance passing.
- Recourse protocol v1, negotiator, three merchant agents, 20-policy eval.
- Simulated home: Echo Show frame, Echo Dot voice-only, timeline scrubber, voice, protocol inspector, proactive badge.
- Seeded inbox and doorbell scenarios; event-sourced ledger.
- Video, README with numbers, friction log, feature requests, real-vs-simulated map.

**Explicitly out of scope for MVP**
- Real merchant integrations or live consumer mailboxes.
- Auto-file without confirmation.
- Amazon Wallet payment flows (referenced, not implemented).
- Speaker identity / per-person ledgers.
- Fire TV overlay and phone rail if time slips (cut order).
- Legal-rights reasoning of any kind.

### 21. Post-MVP / Post-Launch Extensions

1. **Auto-file policies per merchant** (opt-in) — high value, low complexity.
2. **Real doorbell evidence via Ring Partner API certification** — high value, moderate effort.
3. **Live inbox with on-device pre-filtering** — high value, privacy engineering required.
4. **Merchant SDK for the recourse protocol** and a public conformance suite — ecosystem value, moderate effort.
5. **Per-person ledgers** once Alexa+ exposes speaker identity to add-ons.
6. **Amazon Wallet settlement** so credits land as Wallet balance.
7. **Household scorecards** ("which merchants keep their promises") — engagement, low complexity, reputational risk to manage.

### 22. Short Submission / One-Pager Description

Owed is an Alexa+ add-on that works for the household instead of the brand. It captures every promise a business makes in a transaction — delivery windows, ETAs, refund SLAs, guarantees — from the household's receipts, detects breaches with evidence the home already produces (timestamps, carrier scans, doorbell events) and coverage accounting so it never overclaims, then files and settles claims agent-to-agent with the merchant's agent under an open, MCP-shaped recourse protocol. Outcomes live in an event-sourced ledger the household queries by voice: "Alexa, what am I owed?" Built as a self-hosted MCP server (Streamable HTTP, spec 2025-11-25) with MCP Apps views, elicitation and OAuth 2.1 account linking to Amazon's documented add-on contract, and demonstrated through a simulated household (Echo Show, Echo Dot, timeline scrubber, protocol inspector) plus a real-Echo run via a community bridge. Evaluation reports extraction and breach precision and recovery rate across 20 merchant policies. The recourse protocol and policy library are open source.

### 23. Final Pitch

Every household is owed money it will never claim, because claiming costs more than any single promise is worth. Owed puts an agent on the household's side of every transaction — capturing the promise where it's made, proving the breach with evidence, and settling with the merchant's agent in seconds. Alexa+ has hundreds of add-ons that sell to you; this is the one that represents you.