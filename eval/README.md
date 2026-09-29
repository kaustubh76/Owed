# Evaluation

Run it:

```bash
pnpm build
pnpm --filter @owed/eval extraction  # H1: does the rule-based extractor read promises out of merchant email?
pnpm --filter @owed/eval breach      # H2: does the breach engine get it right, and hold back when it cannot?
pnpm --filter @owed/eval recourse    # H3 single-shot: does negotiating beat taking the first offer?
pnpm --filter @owed/eval learning    # H3 repeat games: does knowing who you are arguing with help?
```

Results are written to `eval/results/`, one file per evaluation.

---

## Promise extraction — H1

### What is measured

120 labelled messages in [`eval/src/extraction/corpus.ts`](src/extraction/corpus.ts),
committed to [`data/corpus/extraction.json`](../data/corpus/extraction.json), split into
two halves that are **reported separately and never rolled together**:

- **generated (60)** — templated, so every promise kind meets several phrasings of the
  same commitment. The template defines the label, which is legitimate: a template that
  writes "between 1pm and 5pm tomorrow" *is* the ground truth for what it wrote. It is
  also the easy half.
- **authored (60)** — merchant email as merchants actually write it, wrapped in apology,
  order numbers, tracking codes and small talk. **Twenty-five of them promise nothing at
  all.**

The negatives are the half that decides the result. An extractor with nothing to trip
over reaches perfect recall by reading every number as a commitment, and only precision
catches it. They include the traps a rule-based reader is most likely to fall into: shop
opening hours, sale countdowns, order and tracking numbers, an expiring password link, a
delivery already attempted, and guarantees with nothing behind them.

Two readings are reported: **kind only**, which is what H1 claims, and **kind and resolved
timing**, which is what actually has to be right for the breach engine to do anything with
the promise.

The extractor is rules, not a model — `packages/extractor`, no network, no AWS. Every
extraction carries the sentence it was read from, because a promise a household cannot
trace back to words somebody wrote them is a promise Owed invented.

### Results — first run, before any extractor change

| | precision | recall |
|---|---|---|
| generated, kind only | 95.2% | 93.7% |
| **authored, kind only** | **96.7%** | **76.3%** |
| overall, kind only | **95.7%** | **87.1%** |
| overall, kind and timing | 94.6% | 86.1% |

| kind | precision | recall | right / wrong / missed |
|---|---|---|---|
| delivery_window | 100.0% | 100.0% | 19 / 0 / 0 |
| eta | 100.0% | 80.0% | 12 / 0 / 3 |
| refund_sla | 77.8% | 87.5% | 14 / 4 / 2 |
| appointment_slot | 100.0% | 88.2% | 15 / 0 / 2 |
| guarantee | 100.0% | 90.9% | 10 / 0 / 1 |
| price_match | 100.0% | 63.6% | 7 / 0 / 4 |
| warranty | 100.0% | 91.7% | 11 / 0 / 1 |

**H1 is met on the headline** — it asks for ≥ 0.9 precision and ≥ 0.8 recall, and the
overall figures clear both.

**It is not met on prose.** Authored recall is **76.3%**, under the bar. Nearly a quarter
of the promises a person would read out of real merchant email are missed, and the
templated half is carrying the average. That is exactly why the sets are reported apart.

The one number that came out clean is the floor: **zero false alarms**. Not one of the 25
messages that promised nothing had a promise read out of it. That is asserted as a test
rather than reported as a result, because unlike a threshold it is not a hypothesis —
filing claims nobody was ever owed would make the product unusable.

### What the thirteen misses actually are

Two classes.

**A precedence bug, and it is the whole of the refund_sla precision problem.** A cue is
searched for in a window *around* a time expression, so a word appearing after it counts
as much as one before. "Arriving by 4pm. Guaranteed or we'll credit you" reads the 4pm
deadline as a refund promise, because "credit" sits twelve characters later. Four of the
misses and all four false positives are this. A cue after the clock is weaker evidence
than one before it, and cue proximity should beat the order the cue list happens to be in.

**Vocabulary the rules simply do not have.** "for 30 days", "up to 10 working days", "you
have 28 days", "in the next 21 days" — four ways of writing a duration the pattern misses
because it demands `within|in|after` immediately before the number. Plus three cue words
absent from their lists: "installation", "reach you", "covered for".

The first is a defect in how the rules are applied. The second is a rule-based extractor
being exactly as good as its vocabulary.

### Results — after three rounds of fixing what the corpus found

| | precision | recall |
|---|---|---|
| generated, kind only | 100.0% | 100.0% |
| authored, kind only | 100.0% | 97.4% |
| overall, kind only | 100.0% | 99.0% |
| overall, kind and timing | 100.0% | 99.0% |

Three changes: a cue before the clock now beats one after it however far away; a cue that
can only mean one thing (engineer, warranty, price match) outranks a generic verb sitting
nearer; and the duration pattern accepts "for 30 days", "up to 10 working days" and "you
have 28 days" alongside "within 7 days".

**And this number is worthless as evidence.** It measures a fit, not an ability. The
extractor was changed three times in response to the very messages it is scored against,
and 95.7/87.1 became 100/99 by exactly the process that makes a benchmark meaningless.

### The number that means something — held out

Forty more messages, in
[`eval/src/extraction/heldout.ts`](src/extraction/heldout.ts), written **after** the
tuning was finished and deliberately in voices the first corpus never uses: clipped
courier SMS, a formal letter, a pharmacy, a garage, a ticket agency, a telecoms provider,
a takeaway. Fifteen of them promise nothing. Run **once**. Nothing in the extractor has
been or will be changed because of them.

| | precision | recall |
|---|---|---|
| **held out, kind only** | **73.7%** | **58.3%** |
| held out, kind and timing | 63.2% | 50.0% |

| | tuned corpus | held out |
|---|---|---|
| precision | 100.0% | **73.7%** |
| recall | 99.0% | **58.3%** |

**H1 is met on the corpus it was tuned against and missed badly on data it has not seen.**
It asks for 0.9 precision and 0.8 recall; held out, the extractor reaches 0.74 and 0.58.
It finds **four promises in seven**, and one in four of the things it reports is wrong.

That gap is the most useful measurement in this repository. It is what "we tested it and
it works" is worth when the test was written against the implementation, and it is the
reason every corpus here is pinned and committed before the thing it measures is touched.

Two of the nine held-out misses are the tuning itself backfiring. A `slot` cue was added
because an authored message said "your installation slot is Wednesday" — and on held-out
data it reads a grocery delivery ("your slot is confirmed for tomorrow, 6pm to 7pm") and a
courier text subject-lined "Slot" as engineer appointments. A rule added to catch one
phrasing broke two others, which is the characteristic failure of tuning against a fixed
set and is visible here only because the held-out set exists.

The rest are plain gaps, all of them ordinary merchant English: day-level deadlines with
no clock ("with you by Wednesday", "should arrive by 9 October"), compensation phrased as
a payment rather than a refund, "booked in for" and "consultation" as appointment cues,
a guarantee whose remedy never uses the word, and "parts and labour guarantee" meaning a
warranty. Each is a line of vocabulary away. **None of them will be fixed against this
set** — the whole value of these forty messages is that the extractor has never seen them,
and spending that once buys a number nobody has to take on trust.

### What this does not show

Every message here was written by us. A held-out set written by the same people who wrote
the extractor is better than one they tuned against and worse than real merchant email,
which is what this should be measured on next. There is no prose from a real inbox in this
repository, and no result here should be read as though there were.

---

## Breach detection — H2

### What is measured

Sixty scripted evidence timelines, ten per breach kind, in
[`eval/src/breach/corpus.ts`](src/breach/corpus.ts) and committed to
[`data/corpus/breach.json`](../data/corpus/breach.json).

Each timeline carries a label — `broken` or `kept` — set by **how it was built**, never by
what a detector said about it. A parcel scanned eighty minutes after the window closed is
broken whether or not anything in this repository agrees. Each also carries a one-line
note a human can check the label against without running anything.

- **Precision and recall** are measured over cases the corpus marks `observable`, meaning
  the window was watched to at least 0.7. That is what H2 claims.
- **False-positive rate on kept scenarios** is measured over every `kept` case.
- **Held back** is reported separately: of the cases where something really was broken but
  the camera was starved, how often Owed refused to claim. Rolling those into recall would
  quietly punish the engine for the one behaviour the product most needs it to have.

### Why the corpus is pre-registered

Same protection as the merchant grid. `corpus.test.ts` pins the committed file to the
generator, so dropping the cases that fail, softening a label or reordering the set after
seeing a number all turn the suite red. The corpus was committed **before** the engine was
touched in response to it, and the git history shows that order.

The corpus also checks itself: it states how much of each window should be watchable, and
the test asserts the engine measures the same thing. That caught a real construction bug
— an appointment-slot case believed starved was sitting at 0.79 coverage, because
`missed_window` also applies to a slot and judges the two-hour slot while `no_show` judges
the slot plus thirty minutes of tolerance either side. Watching placed inside the slot
counts for more against the narrower window.

### Results — first run, before any engine change

| kind | precision | recall | kept FPR | held back |
|---|---|---|---|---|
| late_eta | 100.0% | 100.0% | 0.0% | — |
| missed_window | 83.3% | 100.0% | 33.3% | 2/2 |
| phantom_delivery | 80.0% | 100.0% | 33.3% | 3/3 |
| no_show | 75.0% | 100.0% | 25.0% | 3/3 |
| late_refund | 100.0% | 83.3% | 0.0% | — |
| price_drop | 100.0% | 83.3% | 0.0% | — |
| **overall** | **90.0%** | **93.1%** | **13.0%** | **100%** |

**H2 is not met.** It asks for ≥ 0.9 precision *per breach kind* and a false-positive rate
under 5% on kept scenarios. Three kinds are below the precision bar and the false-positive
rate is 13.0%, nearly three times the limit.

Restraint is the one number that came out clean: **every** case where something was broken
and the camera was starved was held back rather than claimed.

### What the five failures actually are

Every one is a boundary, and they fall into three groups.

1. **A promise window is half-open.** `containsInstant` is `[start, end)`, which is right
   for coverage arithmetic and wrong for "did it arrive in time". A parcel scanned at the
   exact instant a 1–5 PM window closed reads as late, and a price that fell at the closing
   instant of a price-match window reads as no drop at all. Two cases, opposite directions.
2. **A partial refund counts as a refund.** Half the money, on time, reads as kept. The
   detector asks whether *something* arrived and never compares it to what was owed.
3. **Evidence one minute outside the tolerance is discarded entirely.** A parcel placed 31
   minutes after the scan, and somebody turning up 29 minutes before an appointment slot
   opened. The detector looks in a ±30 minute window and anything outside it does not exist.

The first two are plainly wrong and were fixed. The third is a declared parameter rather
than a defect, and moving it to make a number go up would be marking our own homework.

### Results — after fixing the two defects

| kind | precision | recall | kept FPR | held back |
|---|---|---|---|---|
| late_eta | 100.0% | 100.0% | 0.0% | — |
| missed_window | 100.0% | 100.0% | 0.0% | 2/2 |
| phantom_delivery | 80.0% | 100.0% | 33.3% | 3/3 |
| no_show | 75.0% | 100.0% | 25.0% | 3/3 |
| late_refund | 100.0% | 100.0% | 0.0% | — |
| price_drop | 100.0% | 100.0% | 0.0% | — |
| **overall** | **93.5%** | **100.0%** | **8.7%** | **100%** |

Two changes, both in `packages/core/src/breach/detectors.ts` and both defensible without
reference to any number:

- **`withinWindow`**, a containment check that counts the closing instant, used wherever
  the question is whether a promise was honoured. `containsInstant` stays half-open and
  stays in use for coverage arithmetic, where adjacent intervals must not double-count.
  "Delivered by five" includes five.
- **A partial refund is a broken promise.** The refund detector now compares what came
  back against what the promise named, where it named one and the currencies agree.
  Telling somebody their refund arrived when half of it did is the one answer they would
  call a lie.

**H2 is still not met.** Two kinds remain below the 0.9 precision bar and the
false-positive rate on kept scenarios is 8.7% against a limit of 5%.

Both remaining failures are the same thing: **evidence one minute outside the ±30 minute
tolerance is discarded entirely.** A parcel placed 31 minutes after the scan reads as a
phantom delivery; somebody turning up 29 minutes before an appointment slot opened reads
as a no-show. In both cases the household got what they were promised and Owed would file
a claim saying otherwise.

That is a real defect and we are naming it rather than fixing it in the same sitting that
found it. Fixing it means deciding what a tolerance is *for* — clock skew between a
carrier and a camera, or the window in which a sighting counts as the same event — and
that is a design decision, not a threshold to nudge. The ideation's own pivot trigger is
"H1 or H2 below threshold **after two iterations**". This is the first.

### What this does not show

The corpus is ours. Sixty timelines written by the same people who wrote the engine is
weaker evidence than sixty drawn from the world, however carefully the labels were set by
construction and however deliberately the cases were placed on the boundaries. The first
draft scored 100% on everything, which is exactly what a corpus written to confirm an
engine looks like, and the only reason this one says anything is that it was rebuilt to
try to break it.

It also says nothing about extraction: every promise here is handed to the engine already
parsed. That is H1, and it is not measured yet.

---

## Recourse — does negotiating beat taking the first offer?

### What is measured

**Recovery share** = what was settled ÷ what the merchant's own published policy says they
owe. The denominator is deliberately the merchant's own figure, not our opinion of what
would be fair — the whole product rests on asserting nothing beyond what they promised, so
the benchmark should too.

**Baselines.** *Do nothing* recovers zero by construction. *Accept the first offer* takes
whatever the merchant opens with. Both are computed from the same sessions.

### The grid, and why it is pre-registered

Owed writes both the negotiator and the merchants it argues with, so a flattering result
means nothing on its own. Three things are done about that.

**The parameter space was fixed before the negotiator was tuned against it**, and the
generated grid is committed to `data/policies/grid.json`. `eval/src/grid.test.ts` asserts
that file still matches the generator — quietly widening the grid, dropping the hostile
merchants or reordering it after seeing a disappointing number turns the suite red.

**It is the full cross product, not a sample.** These are pure functions costing
microseconds, so all 270 policies run rather than a chosen 20.

| Parameter | Values |
|---|---|
| `anchor_ratio` — first offer as a fraction of the published figure | 0, 0.25, 0.4, 0.65, 1 |
| `concession_rate` — how much of the gap they close each round | 0, 0.3, 0.6 |
| `accept_ratio` — they settle at or below this multiple of their published figure | 0.8, 1, 1.2 |
| `declines_at_round` — they refuse outright on this reply; 0 means never | 0, 1, 2 |
| `withdraws_on_counter` — **countering costs you the offer** | false, true |

**It contains merchants the negotiator cannot beat.** Half of them punish a counter and a
third refuse to engage at all. Without those, every cell is a win or a tie, which is
exactly what makes a self-refereed benchmark worthless.

### Results

270 policies × 6 breach kinds = **1,620 negotiations**.

| | Recovered | Share of owed |
|---|---|---|
| Do nothing | $0.00 | 0.0% |
| Accept the first offer | $4,320.00 | 30.8% |
| **Negotiator** | **$4,766.00** | **33.9%** |

- **Lift over the baseline: 1.10×.** Median two rounds.
- **The negotiator does worse in 378 of 1,620 cells (23.3%)** — every one of them a
  merchant that withdraws its offer when countered.
- **540 cells are unwinnable by any strategy**: the merchant refuses on its first reply,
  so nobody recovers anything and both the negotiator and the baseline score zero.

Two conditional readings, because the headline alone is misleading in both directions:

| Condition | Negotiator | Accept first | Lift |
|---|---|---|---|
| Excluding merchants that punish a counter | 36.8% | 30.8% | 1.20× |
| Merchants that engaged at all | 50.9% | 46.2% | 1.10× |

Results are near-identical across all six breach kinds (33.9%–34.1%), which is expected:
the strategy does not vary by breach kind, only the figures do.

### What this does not show

**The pre-registered hypothesis is not met.** `product_ideation.md` H3 predicted ≥ 60% of
owed value and ≥ 1.5× the accept-first-offer baseline. The measured figures are 33.9% and
1.10×. Negotiating is worth doing — it beats the baseline, and it is far better than doing
nothing — but by much less than the hypothesis claimed, and it is actively harmful against
merchants who penalise it.

**The grid weights parameter values uniformly**, which over-represents stonewalling
merchants relative to any real population: a third of them refuse every claim outright.
A grid weighted to a realistic merchant mix would report a higher number. That weighting
was fixed in advance and has not been revisited, which is the point of fixing it.

**The merchants are simulated.** No real merchant has implemented the recourse protocol.
These are policy-driven agents, not observations of real conduct, and they are only as
representative as the parameter space above.

**The negotiator cannot tell merchant types apart.** It counters whenever an offer falls
below the published figure, because on the first reply it has no way to know whether it is
talking to a merchant that will improve or one that will withdraw. A version that learned
per-merchant priors — which the ledger already records — should do better, and that is the
obvious next piece of work rather than a defence of this one.


---

## Learning — does knowing who you are arguing with help?

The single-shot result named its own weakness: the negotiator counters whenever an offer
falls short, because on the first reply it cannot tell a merchant that will improve from
one that will withdraw. That blind spot is the whole of its 23.3% loss rate.

### What it learns, and from where

Per `(merchant, breach kind)`, from a **projection of the ledger** rather than a new store:
how often countering was tried, and what it realised. The rule is a mean and a comparison.

```
offer ≥ the published figure          → accept
fewer than 3 counters on record       → counter   (you cannot learn without trying)
mean realised when countering > offer → counter
otherwise                             → accept
```

Not a model. Every input to the decision sits in the ledger where it can be read.

### Results — 270 policies × 6 breach kinds × 20 episodes

| Strategy | Share of owed |
|---|---|
| Accept the first offer | 30.8% |
| Cold negotiator | 33.9% |
| **Learner, episode 1** | **33.9%** |
| **Learner, settled** | **44.1%** |
| Oracle (knows each merchant's type) | 44.1% |

- **Lift over the baseline rises from 1.10× to 1.43×.**
- **The loss rate falls from 23.3% to 0%.** After three encounters the learner stops
  arguing with merchants who punish it.
- It takes exactly three episodes to switch, which is the exploration threshold.

### Why this stays honest

**Episode one equals the cold negotiator exactly**, and `learning.test.ts` asserts it. Any
divergence would mean the learner is seeing something a household would not have on first
contact — which is the specific way this kind of evaluation usually cheats.

**Evaluation is online and sequential.** Each merchant is met cold; the learner knows only
what it has already experienced with *that* merchant. **The pre-registered grid does not
change** — same 270 policies, same parameters, still pinned to its generator.

### What this does not show

**Reaching the oracle is a property of the simulation, not a triumph of the algorithm.**
These merchants are deterministic: after three identical encounters their type is known with
certainty, so a mean is a perfect classifier. Against merchants who vary — who sometimes
improve and sometimes withdraw — the learner would not converge this cleanly, and 100% of
the available advantage is not a number to expect in the world.

**The hypothesis is still not met.** H3 predicted ≥ 60% of owed and ≥ 1.5× the baseline.
Learning moves the result from 33.9% to 44.1% and from 1.10× to 1.43× — much closer, and
still short on both counts. A third of the grid refuses every claim outright and is
unrecoverable by anyone, which caps what any strategy can reach.

**Learning takes time a household may not have.** Three encounters with the same merchant
about the same kind of broken promise is a lot of broken promises. The figures above are an
upper bound on how quickly the loop pays off, not a description of a first month of use.
