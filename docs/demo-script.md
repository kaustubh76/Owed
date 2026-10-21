# Recording the demo

*A working document for whoever records the video. Under three minutes, English, public
YouTube, no third-party trademarks or music.*

**Every figure and every verdict in this file is checked.** `scripts/verify-docs.mjs`
compares the hypothesis table below against `eval/results/*.json` on every `pnpm verify`,
and the beats marked **[gate]** are asserted by `scripts/verify-ui.mjs` in a real browser.
The last version of this document told a reader to say "breach detection: not met" for
eleven days after it became met, which is why both of those checks now exist.

---

## Before you press record

```bash
pnpm install
pnpm build            # required — the services run from dist/, and nothing builds on install
pnpm preflight        # says yes, or says exactly what is in the way
pnpm verify:ui        # 10-18s on an 8-core laptop. Needs Google Chrome. Run it before recording.
pnpm demo
```

**Three commands, not two.** `pnpm demo` starts four processes from `dist/`, and there is no
`postinstall` hook, so `pnpm build` is not optional. The README used to say two as well.

`pnpm verify:ui` is not in `pnpm verify` because CI has no browser — it is optional to the
gate and **not optional to you**. It drives this exact sequence and checks the numbers on
the cards, so if it passes, the beats below work.

**Set your display to dark mode before you start.** The card follows the viewer's
`prefers-color-scheme` and the surrounding home chrome is always dark, so recording on a
machine in light mode gives you a light card in a dark frame. Both themes are gate-checked
and both are legible; only one of them looks deliberate.

Open **http://127.0.0.1:5173** in Chrome at a size where the Echo Show frame and the
protocol inspector are both fully visible — around 1440×980.

Wait for the header to read **brain connected**. There are three other things it can say,
and they mean different problems:

| header | what is wrong |
|---|---|
| `linking…` | the socket is up, account linking has not finished. Wait. |
| `add-on unreachable` | the brain cannot reach the MCP server. The server is down or the token expired. |
| `brain offline` | the socket itself is down. The brain process is not running. |

The demo starts on **Sunday 19:30** in the seeded week. Leave it there.

Two things worth knowing before you talk over it:

- The spoken lines quoted below are what it actually says. They are generated, not typed
  into this file, and `pnpm verify:ui` asserts the ones marked **[gate]**.
- Nothing needs typing. There is a text box if you want one, but every beat below is a
  button or the microphone.

---

## The take — 2:58 total

**0:00 — the problem, over the idle screen.** *(12s)*

> "Every Alexa+ add-on is a brand selling you something. This one works for the household.
> It watches what merchants promise, notices when they break it, and argues for you."

---

**0:12 — "Alexa, what am I owed?"** *(first chip · 20s)* **[gate]**

The ledger card: **$47.00 recovered · $8.00 still open · 2 kept.**

It says, out loud:

> "You've recovered forty-seven dollars this week, and eight dollars is still open. Two
> promises were kept. There's one I'm not claiming, because I only watched twenty percent
> of the window. There's one more I can file."

Say over it:

> "Three numbers, and a confession. It volunteers the one it *isn't* claiming."

Let that line land. It is the whole product.

---

**0:32 — "Why aren't you claiming that?"** *(second chip · 18s)* **[gate]**

The evidence card. Point at three things, in this order:

1. **The bar.** The unwatched stretches are cut out where they actually fell, not
   left-aligned. The gaps and the coverage number are the same fact.
2. **"They wrote"** — the merchant's own sentence, the one the promise was read out of.
3. **The verdict: *not enough to claim*.**

> "It watched twenty percent of that window. That isn't enough to accuse anyone, so it
> doesn't. It shows you the merchant's own words, what it saw, and what it didn't."

---

**0:50 — the scrubber.** *(drag to Monday, then forward across the week · 15s)* **[gate]**

The ledger empties and refills as you drag.

> "Every tool answers for the clock, not for now. So you can walk through the week."

*If the take is running long, this is the beat to shorten — eight seconds of dragging makes
the point.*

---

**1:05 — Owed speaks first.** *(23s)* **[gate]**

**Scrub back past Sunday 18:25, then forward over it again.** Not 19:30 — **18:25**. That is
when the breach is detected, and the announcement fires on *crossing* that moment, not on
sitting past it. Scrubbing back to anywhere after 18:25 leaves the event already announced
and nothing will happen.

A badge appears — **simulated proactive** — and Owed speaks without being asked:

> "Northwind Parcel missed the delivery window they promised. They owe you eight dollars
> under their own policy. Shall I file it?"

Say:

> "We couldn't find a way for an Alexa+ add-on to speak first — the published docs describe
> no proactive channel. So we wrote the primitive we'd need as a schema, and the inspector
> shows it on the wire."

**Say "we couldn't find", not "can't be done".** The earlier wording here was *"that's the
one thing Alexa+ add-ons can't do"*, and it is the one line in this file that contradicted the
rest of the submission: `docs/proactive.md`, `readme.md` §8.5 and §15, and
`docs/product-feedback.md` all carry the same correction — we checked the documentation, not
the platform, and were later told the public docs omit a good deal, so a proactive path may
well exist. The claim we can evidence is a documentation gap, and that is the claim to make on
camera. Saying the stronger thing would have put a sentence on video that four documents in
the repository already walk back, which is exactly what the "Do not say" list below exists to
prevent.

*(Point at the `commitment/promise_breached` row in the inspector.)*

**Do not skip the badge.** It is labelled simulated because it is.

Crossing the evening fires **three** announcements, not one, oldest first — so the household
is left looking at the most recent. That is deliberate.

---

**1:28 — answer it.** *(22s)* **[gate]**

**Click the "File it" button Owed put on the screen**, under its own announcement — not the
third chip. The chip does the same thing; the button is the point. An announcement a
household cannot answer is a dead end, and we found no documented way for a host to offer
one, so the `CommitmentEvent` carries the utterance and the tool with it.

The claim card: **Asked $10 · They offered $3 · Countered $8, Delivery Guarantee 4.1 ·
Settled $8**, and underneath, what was sent with it.

> "It opened at the ceiling their policy allows. They offered three. It countered by
> quoting *their own* clause back at them, and settled at eight. Nothing here is scripted —
> the merchant agent is a separate process, and it could have said no."

*(Scroll the inspector and expand one recourse row.)*

> "Every frame on that panel was captured on the wire. This is the household's add-on
> arguing with somebody else's agent. Not a mock."

---

**1:50 — by voice, for real.** *(20s)* **[gate]**

Tick **Speak the replies**, then hold **Hold a conversation** and ask *"Alexa, what am I
owed?"* out loud.

> "Both directions are real — browser speech recognition in, speech synthesis out, and
> interrupting it cancels what it was saying. Both are off by default, because a recorded
> take shouldn't depend on a permission prompt."

*Chrome only, and both controls are hidden where the browser has no API. If the microphone
refuses, use the chip and say the line above anyway — it is still true, and
`pnpm verify:ui` proves it.*

---

**2:10 — the Echo Dot.** *(click "Echo Dot", then the first chip again · 15s)* **[gate]**

No card at all. The same answer you just heard by voice — which is **not** the answer from
0:12, and the difference is worth knowing before a judge spots it. Filing at 1:28 moved
`open` from **eight dollars to sixteen**, and dropped the "one more I can file" clause.

That is correct and tested — `claimFile.test.ts`'s "moves the open figure by what it
settled" pins `open` at $16.00 after filing. A claim that has settled is money the merchant
has agreed to and the household has not received, so it stays open until the credit lands,
which is exactly what Owed says it will tell you about. `recovered` holds at $47.00 for the
same reason.

Say so if asked. An $8 claim turning into $16 looks like double-counting, and it is the one
place in this demo where correct behaviour resembles a bug the project has already had and
fixed once — `docs/contract-v1.md` amendment D23, where filing on a derived promise really
did report an $8 failure as $16. The figures to expect, in order: **$8.00 open before the
filing beat, $16.00 after it.**

> "Alexa+ requires every feature to work by voice alone. The only honest way to show that
> is to take the screen away and ask again."

---

**2:25 — the numbers, said plainly.** *(over the README or the eval output · 25s)*

**Say exactly these verdicts.** They are checked against `eval/results/*.json` by
`pnpm verify:docs`, so if this table and the harness disagree, the build fails rather than
you saying the wrong thing on camera.

| hypothesis | verdict | the number to say |
|---|---|---|
| **H1** extraction | met | 100% precision on the corpus it was tuned against — **73.7% precision and 58.3% recall** on forty messages it had never seen |
| **H2** breach detection | met | 100% precision and recall on all six kinds, after three detector defects the corpus had been pointing at |
| **H3** recourse | not met | 33.9% of what merchants owe, at 1.10× the baseline — met on the median-rounds criterion, missed on the other two |

> "Three hypotheses, measured against corpora written before the code, and we publish them
> met or not. Extraction is met on the corpus we tuned it against — and on forty messages it
> had never seen, it finds four promises in seven, and one in four of the things it reports
> is wrong. That gap is the most useful number we have. Negotiation is not met: it recovers a
> third of what merchants owe. And when we let the merchants stop behaving exactly as
> configured, the one number that favoured us inverted — arguing lost to taking the first
> offer. We published that too."

This is not a weakness to hurry past. Most submissions will show a number measured after the
tuning. Showing both, and showing the one that went against us, is the point.

---

**2:50 — close.** *(8s)*

> "It doesn't run on a real Echo — Alexa+ for Builders is partner-gated, and we say so
> everywhere. Everything else here is real, and you can run it in three commands."

---

## Do not say

- **"It works on Alexa+."** It has never run against the real client. The README's §13
  real-vs-simulated table, the contract doc and the submission all say so, and the video must
  match them.
- **"Alexa+ add-ons can't speak first."** We checked the docs, not the platform, and were told
  afterwards that the public docs omit a good deal. Say that we could not find the capability
  documented — which is true, and is the gap the schema answers. `docs/proactive.md` has the
  wording the rest of the submission uses.
- **"Ninety-nine percent recall."** That is the tuned corpus. There are **two** held-out
  figures — 73.7% precision and 58.3% recall — and the table above quotes both. Never the
  tuned one alone.
- **"Breach detection is not met."** It was, for two iterations, and it is in the git
  history. It is met now, and the table above is the current answer.
- **Anything about Bedrock working.** The adapter is written and tested against a local
  server; **no model has ever run.** `docs/product-feedback.md` is careful about this and so
  should you be.
- Any real merchant's name. All four merchants here are invented, and their policies are
  written out in `docs/policies/`.

## If something goes wrong mid-take

- **Nothing renders.** Read the header against the table at the top — `add-on unreachable`
  and `brain offline` are different problems with different fixes. `pnpm preflight` will tell
  you if a port was taken and which service owns it. The page reconnects by itself with
  backoff, so give it a few seconds before reloading.
- **The proactive badge doesn't appear.** You did not scrub back far enough. The moment is
  Sunday **18:25**, not 19:30. Go back before it and cross it again.
- **"File it" says it has nothing in mind.** It replies *"Tell me which promise you mean, or
  ask me what you're owed and I'll bring one up."* Say "Alexa, what am I owed?" first. "File
  it" means the thing just mentioned, which is deliberate — and it applies to the offer
  button too, because the button speaks the utterance rather than passing the promise id.
- **The microphone does nothing.** Chrome only, and it needs permission. Fall back to the
  chip; the claim in the narration is about the feature, and the gate asserts it.

## One more beat, if you want it

`POST /control/messages` delivers a message to the household and shows what Owed read out of
it. One sentence produces two promises at different confidences — one tracked, one recorded
and deliberately not:

```bash
curl -X POST http://127.0.0.1:3939/control/messages \
  -H 'content-type: application/json' \
  -d '{"merchant":"Northwind Parcel","text":"Delivered between 1 and 5pm, guaranteed or your money back."}'
```

It is the extraction threshold made visible. Each promise now comes back with a `verdict`
too — the breach engine runs on what arrives, not only on the seeded week — so both of these
are judged the moment they are captured rather than sitting at `Captured` for the life of the
process.

Then show the home seeing something, and the verdict move:

```bash
curl -X POST http://127.0.0.1:3939/control/evidence \
  -H 'content-type: application/json' \
  -d '{"uptime":[{"source_id":"src_doorbell","household_id":"hh_demo",
       "interval":{"start":"2026-10-11T08:00:00-07:00","end":"2026-10-11T12:00:00-07:00"}}]}'
```

**It announces once, not twice.** Both promises go `Breached` and a presenter watching the
inspector will see two verdicts — but only the window is announced, because the guarantee is
the same failure described twice and the household should be interrupted about it once.
`docs/contract-v1.md` D22 has the rule. Filing on the window silences it; before D22 the
guarantee kept announcing after the claim existed.

Use a **morning** window in the message for this — "Delivered between 9 and 11am" — because
the scrubber's clock is Sunday evening and a bare "1 to 5pm" resolves to *tomorrow*, which no
past evidence can cover. Both promises then read `Breached` at `missed_window` with coverage
1.0: the window because the camera was up across it and nothing arrived, and the guarantee
because it is the same failure described twice. A guarantee has no evidence of its own, so it
inherits its sibling's verdict; filing on it returns the claim the window already has.

**The strongest version of this beat is the one where Owed refuses to watch at all:**

```bash
curl -X POST http://127.0.0.1:3939/control/messages \
  -H 'content-type: application/json' \
  -d '{"merchant":"Northwind Parcel","text":"Covered for 24 months under our manufacturer warranty."}'
```

That reads as a **tracked** warranty at 0.95 — not a `Candidate` — and asking about it gets
*"I've written the Northwind Parcel warranty down, but nothing the home sees would tell me
whether they keep it, so I'm not claiming to watch it."* The card says `not watched` and gives
the same reason. A warranty is broken by a product failing in month fourteen and no doorbell
event settles that, so there is nothing to inherit and nothing to observe.

Ask **"why aren't you watching that?"** after it — there is a chip for it — and the card comes
up reading `not watched`, with the reason where a coverage bar would be. Before D21 that state
existed and nothing in the home could reach it, because the brain only kept track of promises
it had judged.

So there are three different refusals available here, which is worth knowing if a judge pushes
on whether Owed overclaims: declining to **track** a weak read, declining to **claim** a
breach it could not see enough of, and declining to **watch** a promise a household cannot
evidence at all — and all three are on screen, not just on the wire. None of this fits in three minutes alongside everything above; all of it is a
good answer to a question.
