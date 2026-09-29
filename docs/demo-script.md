# Recording the demo

*A working document for whoever records the video. Under three minutes, English, public
YouTube, no third-party trademarks or music.*

---

## Before you press record

```bash
pnpm install
pnpm build
pnpm preflight        # says yes, or says exactly what is in the way
pnpm verify:ui        # optional, ~40s: proves every beat below still works
pnpm demo
```

Open **http://127.0.0.1:5173** in Chrome at a window size where the Echo Show frame and
the protocol inspector are both fully visible — around 1440×980. Wait for the header to
read **brain connected**; it says that only once account linking has actually completed.

The demo starts on **Sunday 19:30** in the seeded week. Leave it there.

Two things worth knowing before you talk over it:

- The spoken lines below are quoted from the running demo. They are what it says.
- Nothing needs typing. Every beat is a button.

---

## The take

**0:00 — the problem, over the idle screen.** *(~12s)*

> "Every Alexa+ add-on is a brand selling you something. This one works for the household.
> It watches what merchants promise, notices when they break it, and argues for you."

---

**0:12 — "Alexa, what am I owed?"** *(click the first chip)*

The ledger card: **$47.00 recovered · $8.00 still open · 2 kept.**

It says, out loud:

> "You've recovered forty-seven dollars this week, and eight dollars is still open. Two
> promises were kept. There's one I'm not claiming, because I only watched twenty percent
> of the window. There's one more I can file."

Say over it:

> "Three numbers, and a confession. It volunteers the one it *isn't* claiming."

Let that line land. It is the whole product.

---

**0:32 — "Why aren't you claiming that?"** *(second chip)*

The evidence card. Point at three things, in this order:

1. **The bar.** The unwatched stretches are cut out where they actually fell, not
   left-aligned. The gaps and the coverage number are the same fact.
2. **"they wrote"** — the merchant's own sentence, the one the promise was read out of.
3. **The verdict: *not enough to claim*.**

> "It watched twenty percent of that window. That isn't enough to accuse anyone, so it
> doesn't. It shows you the merchant's own words, what it saw, and what it didn't."

---

**0:55 — the scrubber.** *(drag to Monday, then slowly forward across the week)*

The ledger empties and refills as you drag.

> "Every tool answers for the clock, not for now. So you can walk through the week."

**Keep dragging to Sunday evening.** A badge appears — **simulated proactive** — and Owed
speaks without being asked:

> "Northwind Parcel missed the delivery window they promised. They owe you eight dollars
> under their own policy. Shall I file it?"

Say:

> "That's the one thing Alexa+ add-ons can't do. They can only answer. So we wrote the
> primitive we'd need as a schema, and the inspector shows it on the wire."

*(Point at the `commitment/promise_breached` row in the inspector.)*

**Do not skip the badge.** It is labelled simulated because it is.

---

**1:25 — "File it."** *(third chip)*

The claim card: **Asked $10 · They offered $3 · Countered $8, Delivery Guarantee 4.1 ·
Settled $8**, and underneath, what was sent with it.

> "It opened at the ceiling their policy allows. They offered three. It countered by
> quoting *their own* clause back at them, and settled at eight. Nothing here is scripted
> — the merchant agent is a separate process, and it could have said no."

---

**1:50 — the inspector.** *(scroll it; expand one recourse row)*

> "Every frame on this panel was captured on the wire. This is the household's add-on
> talking, and this" — *(the marked rows)* — "is the add-on arguing with somebody else's
> agent. Not a mock."

---

**2:10 — the Echo Dot.** *(click "Echo Dot", then the first chip again)*

No card at all. Same answer.

> "Alexa+ requires every feature to work by voice alone. The only honest way to show that
> is to take the screen away and ask again."

---

**2:25 — the numbers, said plainly.** *(over the README or the eval output)*

> "Three hypotheses, all measured against pre-registered corpora, and we publish them met
> or not. Breach detection: not met. Negotiation: not met. Extraction reaches a hundred
> percent on the corpus we tuned it against — and seventy-four on forty messages it had
> never seen. That gap is the most useful number we have."

This is not a weakness to hurry past. Most submissions will show a number that was
measured after the tuning. Showing both is the point.

---

**2:50 — close.**

> "It doesn't run on a real Echo — Alexa+ for Builders is partner-gated, and we say so
> everywhere. Everything else here is real, and you can run it in two commands."

---

## Do not say

- **"It works on Alexa+."** It has never run against the real client. The README, the
  contract doc and the real-vs-simulated map all say so, and the video must match them.
- **"Ninety-nine percent recall."** Quote the held-out number, or quote both. Never the
  tuned one alone.
- Any real merchant's name. Every merchant here is fictional, and their policies are
  written out in `docs/policies/`.

## If something goes wrong mid-take

- **Nothing renders** — the brain is not connected. Check the header, and that all four
  services started (`pnpm preflight` will tell you if a port was taken).
- **"File it" says it has nothing in mind** — say "Alexa, what am I owed?" first. "File
  it" means the thing just mentioned, which is deliberate.
- **The proactive badge doesn't appear** — scrub back before Sunday 19:30 and forward
  again. It fires on *crossing* the moment, not on sitting past it.
