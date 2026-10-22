# Owed against its own requirements

*What `product_ideation.md` said this product had to be, checked against what it is.*

The scope list (§20) and the required safety, security and reliability properties (§10) were
written **before** the code, as part of the ideation document in this repository. This file
walks both, one row at a time, and says for each one where it is implemented, how it was
checked, and whether it holds.

Three things make it worth reading rather than skipping:

- **Every row was checked by running something**, in one pass, on 2026-10-18. Not by reading
  the code and believing it. Where a row says "measured", a command produced the number.
- **Two rows do not hold as written**, and they are marked that way rather than smoothed over.
- **One row was found missing while writing this** — the per-merchant claim frequency cap —
  and was built rather than reworded. It had been required since before the first commit and
  implemented nowhere, which is the kind of gap a document like this exists to surface.

What this is not: a claim that Owed has run on Alexa+. It has not — the platform is
partner-gated, and §13 of the readme carries the real-vs-simulated map.

---

## MVP scope (§20, "Must include")

| Requirement | Where | Checked by | Verdict |
|---|---|---|---|
| Seven promise kinds, six breach kinds | `domain/src/promise.ts`, `domain/src/breach.ts`, `core/src/breach/detectors.ts` | Read out of the schemas (7 and 6), and `kinds.test.ts` asserts a detector covers every one of the seven, with no exemption list | **holds — completed on 2026-10-20.** Two of the seven, `guarantee` and `warranty`, were extractable and had no detector: read out of a merchant's words, written to the ledger, never judged. `derivedBreach` covers both by inheriting the verdict of a promise from the same message, so the six breach kinds stay six |
| Extractor and breach engine with published precision/recall | `eval/src/extraction/`, `eval/src/breach/` | `pnpm eval:all`; figures in readme §10, including the held-out ones. `breach.json` re-ran byte-identical after the seventh detector landed — the H2 harness passes no siblings, so derivation cannot touch the 60-scenario corpus | **holds** |
| Six tools | `mcp-server/src/tools/` | `tools/list` over a real client against the booted server returns exactly the six frozen names | **holds** |
| Three `ui://` views | `mcp-server/src/views.ts` | `alexa/contract.test.ts` reads all three back over the wire with `readResource` and asserts the set of `_meta.ui` pointers is exactly `VIEW_URIS`; `schemas.sync.test.ts` holds `VIEW_NAMES` and `VIEW_URIS` together; `verify:docs` compares both documents' tool tables and view URIs to the `registerAppTool` call sites; and `verify:ui` renders all three in a browser; since 2026-10-22 `apps/brain/src/alexaPlusClient.test.ts` also reads all three back through a **third party's** MCP Apps host, which enforces the published MIME type and computes the CSP itself | **holds — and this row was false in both halves until 2026-10-22.** It said `verify:docs` compared the contract's table to the registered tools, and that file contained no tool name, no `ui://` URI and no `tools/list`: a claim about a check, where the check did not exist, in the document that exists to check claims. I implemented that half and left the other one standing — it also said `verify:ui` read the three back *over the wire*, and `verify:ui` has no `readResource` at all; it drives them through the sandboxed iframe, which is a different and weaker thing. The over-the-wire read was always in `alexa/contract.test.ts`, credited to the wrong gate |
| No tool is callable from inside a view | `mcp-server/src/views.ts` (`MODEL_ONLY`) | `alexaPlusClient.test.ts` asks a third party's host which tools it would let a view call — `isAppCallable` over the live `tools/list` — and requires the answer to be none, plus `visibility: ["model"]` on each of the six | **holds since 2026-10-22, and did not before.** Owed declared `resourceUri` and no `visibility`; MCP Apps' published default is `["model", "app"]`, so a sandboxed view was permitted to call every tool, `claim_file` included. Unobservable from inside this repository — Owed's own host builds its `AppBridge` with a null client, so it never wires view-to-tool calls at all. Contract amendment D26; friction log §20 |
| Elicitation | `tools/claimFile.ts` | `alexa/contract.test.ts` drives both branches — the declared-capability one and the explicit `confirm` | **holds** |
| OAuth 2.1 + PKCE | `mcp-server/src/auth/` | Live against the booted server: `code_challenge_methods_supported: ["S256"]`, and no `registration_endpoint`. The mechanism itself is driven, not only advertised — see the §10 row below — and a third party's client library now performs the whole discovery-and-link sequence against it | **holds** |
| Conformance passing | `scripts/conformance.mjs` | `pnpm conformance`, in `pnpm verify`, against a real booted server | **holds** |
| Recourse protocol v1 and negotiator | `packages/recourse-protocol/`, `core/src/negotiation/` | Property tests plus the recorded wire transcript the inspector renders | **holds** |
| **Three** merchant agents | `packages/merchant-agents/` | Live: `GET /merchants` on 3941 returns **four** — Northwind Parcel, Meridian Rides, Alder Home Services, Calder & Co. | **exceeded** — four, not three |
| **20**-policy eval | `data/policies/grid.json` | `eval/src/grid.test.ts` pins **270** policies, generated from five parameters before the negotiator was tuned | **exceeded** — 270, not 20; readme §10 explains the change to a pre-registered quantity |
| Simulated home: Echo Show frame | `apps/home/` | `verify:ui` asserts the canvas at 768×480 with no horizontal overflow | **holds** |
| Echo Dot, voice-only | `apps/home/` | `verify:ui`: "the Dot has no screen" (zero card elements), and it still answers | **holds** |
| Timeline scrubber | `apps/home/` | `verify:ui` scrubs to Monday and back; the scheduler answers per instant, pinned both ways | **holds** |
| Voice, in and out | `apps/home/` | `verify:ui`: speech recognition offered, TTS speaks, barge-in cancels, both off by default | **holds** |
| Protocol inspector | `apps/home/` | `verify:ui`: the commitment event and the recourse exchange both appear, captured at the transport | **holds** |
| Proactive badge | `apps/home/`, `proactive/` | `verify:ui`: the announcement is labelled `simulated proactive` and carries its offer | **holds** |
| Seeded inbox and doorbell scenarios | `mcp-server/src/seed/` | 81 ledger events — 11 `PromiseCaptured`, 18 `EvidenceObserved` — and every promise re-extracted from its own message to the minute | **holds** |
| The breach engine runs on what arrives, not only on the seed | `mcp-server/src/app.ts`, `core/src/ledger/assess.ts`, `tools/projections.ts` | `POST /control/messages` then `POST /control/evidence` against a booted stack: both promises judged, the guarantee inheriting `missed_window` at coverage 1.0. `evidence.test.ts` drives the same path | **holds — completed on 2026-10-20.** `PromiseAssessed` was emitted only by `seed/build.ts`, so a promise captured at runtime was never judged for any kind, and there was no route by which evidence could arrive. Both paths now share one assessment step |
| Event-sourced ledger | `core/src/ledger/` | Append-only behind a two-method port; memory, `node:sqlite` and DynamoDB adapters replay identically | **holds** |
| README with numbers, friction log, feature request, real-vs-simulated map | `readme.md`, `docs/` | `verify:docs` checks entry counts, citations, links and the hypothesis verdicts against the harness output | **holds** |
| Demo video | — | Not recorded | **outstanding** — the last unchecked box in readme §15 |

---

## Required properties (§10)

| Property | Where | Checked by | Verdict |
|---|---|---|---|
| OAuth 2.1 + PKCE (S256) for account linking | `auth/router.ts`, `auth/codes.ts` | Live discovery, and the brain walks a real authorization-code + PKCE link at boot. Then the guarantee rather than the flow: `auth/codes.test.ts` pins the verifier comparison, the RFC 7636 43–128 bounds at both ends and the `timingSafeEqual` length guard a malformed challenge hits; `auth.test.ts` drives the two attacks the mechanism exists for — a replayed code, and a valid code with the wrong `code_verifier` — through `/oauth/token` over real HTTP. And since 2026-10-22 a client nobody here wrote links an account end to end: `mcp-voice-simulator`'s `discoverProtectedResource` → `discoverAuthorizationServer` → `linkAccount`, with its own PKCE verifier, against the real server | **holds — tested on 2026-10-21.** The implementation was already correct; `codes.ts` had no test file, and nothing in the suite mentioned `code_verifier`, a replay or expiry. Advertising S256 and performing it are different claims |
| Owed's own AS issues scoped tokens | `auth/`, `auth/tokens.ts` | `scopes_supported` on the protected-resource document, and three ways a token can be the wrong token, each refused on a real `tools/list`: expired, minted for another resource with this server's own signing key (the RFC 8707 binding), and a refresh token presented as an access token | **holds — tested on 2026-10-21.** The expiry test asserts an unexpired token with the same claims is accepted, so it cannot pass against a gate that refuses everything |
| Every tool call bound to a household id **from the token** | `auth/middleware.ts`, `app.ts` | The id is read from the verified token's claims, never from the request. `auth.test.ts` covers a token for another household, a token naming **no** household, and a token whose scopes are not the household's | **holds — and did not, until 2026-10-21.** The id came from the claims *or, when they named none, from configuration*. A `client_credentials` grant this server advertised and implemented issued exactly such a token to anyone with a public client id, and it read the whole week. The grant is gone, `/mcp` demands `owed.read`, and a token naming no household now reads an empty ledger. Contract amendment D25 |
| Minimum data — promises and evidence pointers, not mailboxes | `domain/src/evidence.ts` | Evidence carries a kind, an instant and a pointer; no message bodies are stored beyond the quoted sentence a promise was read from | **holds** |
| Snapshots retained 30 days | — | Nothing implements retention | **not built** — persistence is off by default and the seeded week is rebuilt on every boot, so there is nothing to expire. Stated here rather than implied |
| Evidence shared with merchants only as the pack the user approved | `tools/claimFile.ts` | `attach_evidence` defaults true and is the only path; the claim card shows what went with it | **holds** |
| No third-party analytics | — | No analytics dependency exists | **holds** |
| The household is told when Owed cannot act | `apps/home/src/App.tsx`, `apps/brain/src/session.ts` | The status badge distinguishes both hops — the socket to the brain, and the brain's own session with the add-on — and `verify:ui` kills the add-on and asserts the badge warns and the controls disable | **holds differently.** The badge was already honest; the *controls* were not, and read the socket alone, so with the add-on gone the microphone, scrubber and proactive offer all behaved as though someone were listening. Fixed on 2026-10-21. **And the warning is not prompt**: see below |
| Evidence source down → cannot escalate to `Breached`, and the household is told what was not watched | `core/src/breach/` | The coverage gate: below `BREACH_COVERAGE_MIN` the verdict is `Suspected`, never `Breached`, and the card draws the gaps | **holds differently** — §10 named a `Degraded` regime; the guarantee is delivered by coverage accounting instead, and the word appears nowhere in the code |
| Merchant agent unreachable → claim falls back to email route with the same pack | `core/src/negotiation/filing.ts` | `fileWithoutAgent` emits `ClaimProposed` + `ClaimFiled` with route `email` where the policy publishes a contact, else `manual`; `claimFileNoAgent.test.ts` drives it against a directory that cannot answer | **holds — and extended on 2026-10-21.** A merchant that *answers unusably* now routes to the same place. §10 named the absent merchant; the reachable-but-lying one discarded the claim entirely, which is the failure this row exists to prevent. `claimFileLyingAgent.test.ts` drives it |
| Bedrock unavailable → ledger and tools stay readable | `mcp-server/src/app.ts` | Stronger than required: the server imports `@owed/extractor` only. `extractor-bedrock` is not on the request path at all, so Bedrock cannot affect it | **holds** |
| One negotiation per promise | `tools/claimFile.ts` | `findClaimForPromise` returns the existing claim rather than filing a second; `claim_file` is idempotent per promise | **holds** |
| Three-round cap | `domain/src/coverage.ts` | `MAX_NEGOTIATION_ROUNDS = 3`, read by the negotiator; the eval's median is 2 rounds | **holds** |
| Per-merchant claim frequency cap | `domain/src/coverage.ts`, `tools/claimFile.ts` | `MAX_CLAIMS_PER_MERCHANT = 5` over `CLAIM_WINDOW_DAYS = 7`, counted over the ledger; five tests pin both sides of the boundary | **holds — built on 2026-10-18.** It was required here and implemented nowhere, and was not listed as not-built either |
| No auto-file in v1 | `tools/claimFile.ts` | Elicitation or an explicit `confirm`; `verify:ui` clicks the household's own "File it" | **holds** |
| Append-only ledger | `core/src/ledger/` | The DynamoDB adapter's whole guarantee is one conditional write plus an atomic counter; "never rewrites an event that is already there" is a test | **holds** |
| Every claim message carries its claim id | `recourse-protocol/src/messages.ts` | `claim_id` is required on every message in the union | **holds differently** — §10 said "signed with claim id"; the id is carried on every message, not cryptographically signed |
| The inspector renders the exact wire messages | `apps/home/` | Frames are tapped at the transport, not reconstructed; `verify:ui` reads them off the panel | **holds** |
| Useful read-only if every external source is offline | `tools/reads.ts`, `tools/ledgerSummary.ts` | Neither reads any merchant or performs any fetch — the read tools project the ledger and nothing else | **holds — and was false for a different reason until 2026-10-21.** Offline was never the threat to this row. A merchant that *answered*, with a settlement in another currency, wrote an event `summarize` cannot fold; both read tools project through it, and the ledger is append-only, so `ledger_summary` and `promises_list` failed permanently from the next call. Not reading an external source is not the same as being unbreakable by one. See contract amendment D24 |

---

## How to re-run this

```bash
pnpm preflight        # a machine that can run it says so
pnpm verify           # eight gates: graph, docs, build, lint, tests, eval, conformance, deploy
pnpm verify:ui        # 66 browser assertions and four accessibility audits, needs Chrome
                      # (also a CI step since 2026-10-21 — it is not in the chain above)
pnpm demo             # four processes; the home at http://127.0.0.1:5173
```

Measured on an 8-core machine on 2026-10-22: `pnpm verify` 17s, or 28s with every Docker-backed
gate demanded (~80s on CI's two-core runner), `pnpm verify:ui` 11s locally and 20s on CI (66
browser assertions, zero failures), the whole suite green with DynamoDB Local up — one test
skipped, a placeholder. **No test count is quoted here, deliberately.** This line read "570 tests
across 50 files" while the suite had 587 across 52, because a count in prose has nothing holding
it: readme §13 dropped its own for exactly that reason, and this one cannot be gated without
running the suite inside `verify:docs`, which would be circular. The strongest local run is
`OWED_REQUIRE_DYNAMO=1 OWED_REQUIRE_VALIDATORS=1 OWED_DOCKER_VALIDATORS=1 pnpm verify`, which
refuses to skip the eight DynamoDB tests and runs `shellcheck`, `systemd-analyze` and
`caddy validate` in Linux containers rather than reporting them as unavailable.

The two rows marked **exceeded** are expansions of a pre-registered quantity, which is
recorded as such in readme §10 rather than treated as a free upgrade. The two marked **holds
differently** deliver the property under another name, and the difference is named so a reader
can disagree with the substitution.

A fix in the first of those rows was itself half-done, and is worth recording because it is
the same failure one level up. `promise_check` was supposed to stop claiming to watch a
promise nothing watches, and it decided that from `watchable()` — a structural predicate that
asks each detector's `appliesTo`. `derivedBreach` matches `guarantee` and `warranty` on kind
alone, because `appliesTo` receives the promise and not the ledger, so **"Covered for 24
months under our manufacturer warranty."** stayed a tracked 0.95 promise that nothing judged
and that Owed described as "I'm still watching". The evidence card was never wired to the new
field at all, while this document and the contract both said it was. Both are fixed, both are
mutation-proved, and `watched` is now answered from ledger state.

The two rows marked **completed on 2026-10-20** were found by this walk rather than by the
gates, which is the argument for doing it: 450 tests, five gates and two document audits were
all green while two of seven promise kinds went unjudged and the breach engine never ran
outside the seed builder. Both are now covered by tests that fail if they regress —
`kinds.test.ts` has no exemption list, and `evidence.test.ts` drives the live path a judge
touches.

One consequence worth stating. Posting evidence or uptime that overlaps a promise the ledger
has already judged re-judges it, including promises in the seeded week — that is correct on new
information, and it is also the one way a live request could move the figures the demo rests
on. Three tests hold that line: `messages.test.ts` and `evidence.test.ts` each assert
`recovered`, `open` and `kept` across a live post, and `verify:ui` reads three of them out of a
browser.

One more row turned out to be a different kind of gap, and it is the kind this walk is worse
at finding. The two OAuth rows above were **true and untested**. `auth.test.ts` was thorough
about the shape of the authorization server — S256 advertised, no dynamic registration,
metadata at both RFC 9728 locations, unknown clients and unregistered redirect URIs refused, a
full authorization-code flow walked, refresh exchange, household scoping — and none of it
touched what PKCE is *for*. `packages/mcp-server/src/auth/codes.ts`, which holds all three
guarantees (the verifier comparison, single-use redemption, five-minute expiry), had no test
file at all, and the string `code_verifier` appeared in exactly two places in the repository —
the helper that sends it and the endpoint that reads it — and in no test. Reading the implementation first found no bug, which is the only reason
this is a coverage note and not a security fix.

Seventeen new tests close it, and each was proved by breaking the code it guards and watching
the right ones go red — five mutations, restored from backup copies rather than
`git checkout`:

| mutation | what went red |
|---|---|
| `verifyCodeChallenge` returns `true` unconditionally | 6 — four unit, and both attack tests at the endpoint |
| `redeem` stops deleting the code | 4 — the replay test at both levels, the expired-code-is-spent test, and the failed exchange that must burn the code anyway |
| `verifyToken` stops checking `audience` | the RFC 8707 row's test, alone |
| `verifyToken` forgives an expiry a century old | the expiry test, alone |
| `verifyToken` stops distinguishing `kind` | the refresh-as-access test, alone |

The last three going red one at a time is the useful part: it says each test discriminates the
claim in its own row rather than the general fact that the gate works.

One more row was true in the way that matters least. "Useful read-only if every external
source is offline" was written about *absence* — no merchant reachable, no fetch performed —
and the read tools genuinely perform none. The threat was never absence. A merchant agent that
answered, in a currency nobody asked for, got its amount accepted by a negotiator comparing
`minor` integers without reference to the unit, written to an append-only ledger as a `Settled`
event, and from the next read onward `summarize` threw `currency mismatch: USD vs EUR` — taking
both read tools out for good, from one reply, unrecoverably.

Three things about how that survived are worth more than the fix. The **four reference agents
cannot produce such a reply**: their MCP server declares `outputSchema:
RespondentMessageSchema`, so eight conformance runs over real HTTP were eight runs against
agents that are structurally honest. The package **ships a conformance checker that includes
the one currency check in the repository** — `sameCurrency`, in `messages.ts` since the
protocol was written — and `checkMerchantConformance` has **no runtime caller at all**, so that
check only ever ran in tests. And `session.ts` already refused a reply carrying someone else's
claim id, two lines from where the currency was not checked: the shape of the guard was there,
with one of its three cases missing.

The fix is in all three places that were wrong, each mutation-proved separately — the check
itself (removing it reddens the three currency tests and nothing else), the recovery (removing
it loses the claim and speaks the raw exception), and the handshake ceiling (removing it runs
to the SDK's 60s default). What makes it safe to make this change three days from a deadline is
`verify:eval`: all five published reports re-derived byte-identically afterwards, which is
1,620 simulated negotiations confirming no honest merchant was newly refused.

**One limitation is disclosed rather than fixed, and it is worth being precise about.** Killing
the add-on changes nothing the household can see until somebody speaks. The brain reaches the
add-on over Streamable HTTP with no long-lived stream, so there is no socket close to observe
and `client.onclose` never fires; the brain discovers the loss when it next calls a tool, which
an utterance does, and only then tells the home. Until then the header still reads "brain
connected".

That is the same *shape* as the defect the badge was built to fix — a header claiming health
while every utterance fails — and it is not the same defect: the brain recovers correctly on
that next call, retrying once and re-linking through a full authorization-code walk, and the
household's next question is answered or honestly refused rather than silently dropped. Making
the badge prompt means the brain probing the add-on on a timer. The machinery is already there
— the brain polls `/control/*` once a minute for proactive announcements and logs a failure
without telling the home — so the fix is to wire that signal to the session status rather than
to add traffic. It is not being done three days from the deadline, on a path the demo never
takes, which is a decision rather than an oversight.

What *is* fixed is the part that misled: once the brain has told the home, the controls stop
pretending. `verify:ui` now ends by killing the add-on, speaking, and asserting that the badge
reads "add-on unreachable" **while the socket to the brain is still open** — the middle state,
which is the only one where the old condition was wrong — and that the microphone and the
scrubber are both disabled. Reverting the controls to read `connected` reddens exactly those
two checks and leaves the two badge checks green. They are the gate's first four assertions
that are not the happy path; every one before them waits for `.app__status--on` before
asserting anything, which is why none of this was visible.

**The Alexa+ track, checked against the platform rather than against this document.** Owed
passes all five documented checks of the published `mcp-voice-simulator` conformance tool plus
its one advisory check — Streamable HTTP, a bare 401 unauthenticated, no `WWW-Authenticate`,
`S256` advertised, and `authorization_code` among the grants. That tool is the only
machine-readable statement of the platform's MCP requirements available here, and it is
deliberately narrow: it checks that `authorization_code` is **present**, never that it is the
only grant. So the server advertised and implemented `client_credentials` — which Amazon's
account-linking documentation excludes — and every gate stayed green while a bare client id
read the household's ledger. Amendment D25 has the chain and the fix.

The lesson is about the shape of the check rather than this one grant. A conformance tool
written against published requirements can only test what the requirements say; "only the
Authorization Code Grant" is prose in Amazon's documentation and an *absence* in the protocol,
and an absence is what a presence check cannot see. Everything the platform forbids rather
than requires is in that category, and the three now pinned by name in `auth.test.ts` — no
dynamic client registration, no `WWW-Authenticate` on a 401, and no grant but the two a
household's add-on uses — are pinned because a test was written for each, not because the
checker asked.

**Ten of the rows above cited a verifier that ran nowhere, and now it runs on every push.**
`pnpm verify:ui` — the Echo Show canvas, the Echo Dot's voice-only parity, the scrubber, voice
in and out, the inspector, the proactive badge, the three `ui://` views, the failure path,
no-auto-file, and the exact wire frames — was in neither `pnpm verify` nor the workflow.
Three places in the repository said it was excluded "because CI has no browser", and none of
them was a measurement: `git log -S chrome -- .github/` was empty across every commit. Nobody
had tried.

It works. All sixty-six checks run on a GitHub runner in twenty seconds, including the
voice-only parity that is a certification requirement and the computed contrast figure. Those
ten rows no longer depend on a human remembering, and the three claims have been corrected
rather than left as folklore. It stays out of `pnpm verify` for the original good reason — a
clean clone may have no Chrome, and `preflight` reports it as optional — so it is a CI step
named in `verify-docs.mjs`'s `EXTRA_STEPS`, which now requires a named step to be present.

One figure was reported and never checked. The gate prints the tightest *passing* contrast
ratio, `readme.md` §15 calls that "the gate's own output" and `docs/contract-v1.md` §7
tabulates it under Amazon's documented targets — and both numbers got there by being copied
out of a terminal by hand, so the one accessibility claim that names a measurement was the one
nothing compared. The gate now asserts that both documents quote the figure it just computed.
That was only worth asserting once it ran in CI; before, a stale number would have sat in two
documents until somebody looked.

---

## Explicitly out of scope (§20, the other half)

This document walked **Must include** row by row and never mentioned the six things §20 says
the MVP would *not* build. An exclusion is a commitment too, and a silently broken one is a
scope breach — the first thing anyone comparing a submission to its own plan would look for.
None is broken, and two are now checked rather than asserted.

| Ruled out | How it is held | Verdict |
|---|---|---|
| Real merchant integrations or live consumer mailboxes | `verify:docs` reads every non-test `.ts`/`.tsx` under `packages/` and `apps/` — 117 files, comments stripped — and fails on any `http(s)://` literal that is not loopback. The one allowance is named with its reason: Alexa+'s three region-specific account-linking redirect URIs, which the platform requires and which nothing dereferences | **gated.** A fourth Amazon host fails, so the allowance is three URIs and not a domain |
| Auto-file without confirmation | §10's "No auto-file in v1" row above — elicitation or an explicit `confirm`, and `verify:ui` clicks the household's own "File it" | **gated**, by that row's own tests |
| Amazon Wallet payment flows | Referenced in prose, implemented nowhere: no occurrence of `wallet` under any `src` | **stated** |
| Speaker identity / per-person ledgers | `verify:docs` fails on `speaker_id`, `person_id` or `voiceProfile` in product source. One household id, carried on the token and every event — which is also what §10's binding row depends on | **gated** |
| Fire TV overlay and phone rail | Not built, and recorded as not-built in readme §13's real-vs-simulated map rather than left implied | **stated** |
| Legal-rights reasoning of any kind | What the product reasons about is a merchant's **own published clause** — `policy-library` resolves it and `claim_file` cites it by title, which is why the demo's counter quotes "Delivery Guarantee 4.1" and never a statute | **stated, deliberately not gated** |

The last row is the one worth being explicit about, because gating it would be theatre. A
check could only be a word list — statute, regulation, ombudsman, small claims — and a gate
that fails the day somebody writes "regulation" in a comment is a gate that gets deleted
rather than heeded. This repository has reported a sentence *about* a thing as the thing three
times now; a vocabulary gate would be the fourth. The design fact is the evidence: there is no
statutory input to reason from, because the only authority Owed ever cites is the merchant's
own policy text.
