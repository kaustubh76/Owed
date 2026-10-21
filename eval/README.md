# Evaluation

> **`eval/results/` is excluded from `biome` (see `biome.json`).** These files are written by
> the harnesses with `JSON.stringify(…, null, 2)`, which is not byte-identical to biome's
> formatting — so formatting them once means the next `pnpm eval:all` leaves the tree dirty
> and fails `pnpm lint`. That would make re-running the numbers a chore, which is the
> opposite of the point. `docs/demo-capture.json` is excluded for the same reason. The
> *corpora* under `data/` are not excluded: those are inputs, they are pinned to their
> generators by tests, and they should never change without someone meaning it.


Run it:

```bash
pnpm build
pnpm --filter @owed/eval extraction  # H1: does the rule-based extractor read promises out of merchant email?
pnpm --filter @owed/eval breach      # H2: does the breach engine get it right, and hold back when it cannot?
pnpm --filter @owed/eval recourse    # H3 single-shot: does negotiating beat taking the first offer?
pnpm --filter @owed/eval learning    # H3 repeat games: does knowing who you are arguing with help?
pnpm --filter @owed/eval latency     # p95 per tool, over Streamable HTTP against a real server
pnpm --filter @owed/eval robustness  # does H3 survive merchants that do not behave exactly as configured?
```

`pnpm eval:all` from the repository root runs all six in order.

One more exists and is **not** run by default, because it costs money and calls a network
service:

```bash
AWS_REGION=us-east-1 pnpm --filter @owed/eval extraction:bedrock   # H1 again, with a model
```

It needs `bedrock:InvokeModel`. It is kept out of `pnpm test` on purpose: the corpus test
below asserts that *nothing* is read out of the twenty-five messages that promise nothing,
and a model behind that assertion would fail CI whenever it misread one. That is not a
flaky test — it is a correct test of a non-deterministic thing, which is a worse problem to
have.

Results are written to `eval/results/` — or to `$OWED_EVAL_RESULTS` when that is set, which is how `pnpm verify:eval` re-derives a report without touching the committed one, one file per evaluation.

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

The extractor **measured below** is rules, not a model — `packages/extractor`, no network,
no AWS. Every extraction carries the sentence it was read from, because a promise a
household cannot trace back to words somebody wrote them is a promise Owed invented.

A second, model-backed extractor now exists —
[`packages/extractor-bedrock`](../packages/extractor-bedrock) — scored by the same
`scoreExtractions` over the same corpus, so the two columns are comparable. **It has not
been run:** it needs `bedrock:InvokeModel`, which the Phase 1 IAM policy does not grant, and every number in this file is
still the rules extractor's. The model-backed one enforces the same evidence rule by
discarding any extraction whose quote is not literally in the message, so a hallucination
costs it recall rather than producing a card citing words nobody wrote.

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

**Six breach kinds, seven promise kinds, and what this corpus does not cover.** `guarantee`
and `warranty` are assessed derivatively — a guarantee has no evidence of its own, so
`derivedBreach` gives it the verdict of a promise read from the same merchant message, and
reports that promise's breach kind rather than a seventh. Nothing here measures that path:
`measureBreachDetection` judges one scenario at a time and passes no siblings, which is why
these figures re-ran **byte-identical** when the seventh detector landed. The derivation is
covered by `packages/core/src/breach/kinds.test.ts` and by the live path in
`packages/mcp-server/src/control/evidence.test.ts` instead, and it is correct to say H2
measures six kinds of evidence-bearing detection rather than all seven promise kinds.
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
3. **Two cases around the ±30 minute tolerance.** A parcel placed 31 minutes after the
   scan, and somebody turning up 29 minutes before an appointment slot opened. Both were
   read here as the same thing — evidence outside the tolerance being discarded — and
   **that was wrong about the second one.** See the third stage below: they had different
   causes, and neither was the parameter.

The first two were plainly wrong and were fixed immediately. The third was left, because at
the time it looked like a declared parameter rather than a defect, and moving a threshold to
make a number go up is marking your own homework.

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

**H2 was still not met at this stage.** Two kinds remained below the 0.9 precision bar and
the false-positive rate on kept scenarios was 8.7% against a limit of 5%. Both failures were
false positives on promises the merchant had kept, which is the worst direction for this
product to be wrong in: the household got what it was promised and Owed would have filed a
claim saying otherwise.

This write-up then said the two were *the same thing* — evidence outside the tolerance being
discarded. **That was true of one of them.** Reading the code case by case, rather than
trusting the summary, found three defects where it claimed one parameter, and one of them had
been masking another.

### Results — after fixing the three detector defects

| kind | precision | recall | kept FPR | held back |
|---|---|---|---|---|
| late_eta | 100.0% | 100.0% | 0.0% | — |
| missed_window | 100.0% | 100.0% | 0.0% | 2/2 |
| phantom_delivery | **100.0%** | 100.0% | **0.0%** | 3/3 |
| no_show | **100.0%** | 100.0% | **0.0%** | 3/3 |
| late_refund | 100.0% | 100.0% | 0.0% | — |
| price_drop | 100.0% | 100.0% | 0.0% | — |
| **overall** | **100.0%** | **100.0%** | **0.0%** | **100%** |

**H2 is met.** And because that sentence is worth less than the order it arrived in:

1. The corpus was committed first, in `2fe6ad2`, and **has not been touched since**. A
   coordinated edit to the generator and the artefact would pass every test in this
   repository — `corpus.test.ts` defends the file against being edited alone, not the pair
   against being edited together — so the only thing standing behind "we did not move the
   goalposts" is the git history, and it is checkable.
2. **The harness was corrected before the detectors**, in its own commit. It printed
   "≥ 0.9 precision *per kind*" and tested `overall.precision`, the pooled figure, which was
   already 93.5% and passing. Had the false positives been fixed first, it would have printed
   "met" without ever evaluating the per-kind bar it advertised. It now names every kind
   below the bar, and it was re-run before anything else changed, still NOT met.
3. **The detectors changed last**, after reading which two cases failed and why.

The **±30 minute tolerance is unchanged**. So is every figure the demo rests on. The three
corrections are about which question each detector was asking:

- **An arrival is evidence something arrived, wherever it falls.** `phantomDelivery`
  filtered doorbell sightings to the scan's ±30 minute window, which is the right window for
  "are these the same event" and the wrong one for "did this parcel ever turn up". A parcel
  photographed on the doorstep at +31 minutes produced a claim stating the door "recorded
  nobody arriving", at confidence 1.0, with the photograph one `filter` call upstream. The
  matching window still distinguishes "the scan is corroborated" from "it arrived, 31 minutes
  from the scan" — both of which are *kept*.
- **`no_show` asks whether anybody came. `missed_window` asks whether they came in time.**
  `no_show` was answering both and getting the second wrong: it widened the slot by the
  tolerance to look for an arrival, then judged the arrival it found against the un-widened
  slot. An arrival 29 minutes early produced `Breached` carrying the explanation "Somebody
  arrived for the appointment." Lateness is `missedWindow`'s question, it applies to
  appointment slots too, and `assess` already takes the most severe answer — so the fix is
  for this detector to stop guessing.
- **A window is missed by being late, not early.** `missedWindow` treated anything not
  `withinWindow` as broken and computed lateness as `arrival − window.end`, so an early
  arrival was reported as a breach with a *negative* number of minutes:
  *"Arrived -149 minutes after the window closed."* This one was masking the `no_show` fix —
  correcting `no_show` alone would have changed nothing, because `missedWindow` reached
  `Breached` on the same case and outranks it.

Each is a correctness argument that stands without knowing what it does to a number, which
is the bar the two earlier fixes were held to. **Recall was already 100% on all six kinds and
stayed there**, so no precision was bought with a miss. Exactly one case in the sixty has an
early arrival and it is labelled `kept`; every late arrival is labelled `broken`.

**What this rests on, and what was done about it.** An arrival sighting attached to a promise
is taken as evidence that promise was fulfilled, at any offset. That is sound only while
evidence carries a `promise_id` — and `assessPromise` used to admit evidence that carried
*none*, to every promise in the household. Before the fix above, an untagged stray sighting
had to land within half an hour of a carrier scan to wrongly clear a promise. After it, the
sighting only had to exist.

So the filter was tightened: **evidence now reaches only the promise it names.** That clause
turned out to have no live purpose at all — both seed constructors and this corpus take
`promise_id` as a required argument, the only runtime producer hard-codes it, and the ledger
projection already dropped untagged evidence on the way in. The sole thing relying on it was
the breach test suite's own fixtures, which omitted the field out of convenience; they now
set it, and four tests assert the two directions that matter: an untagged sighting does not
clear a promise, another promise's sighting does not either, and the promise's own still
does. The projection's matching guard, which had been untested in both directions, is tested
too.

The figures above are unchanged by it, because nothing in the corpus was ever untagged.
Uptime stays household-wide, deliberately: what a camera could see is not a property of any
one promise, and "it was up and saw nothing" is the whole phantom-delivery signal.

The ideation's pivot trigger was "H1 or H2 below threshold **after two iterations**". H2 took
three, and the third one is the first time the engine was changed on the strength of reading
the failures rather than the summary of them.

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

**The pre-registered hypothesis is met on one of its three criteria.**
`product_ideation.md:162` predicted ≥ 60% of owed value, ≥ 1.5× the accept-first-offer
baseline, **and a median of ≤ 2 rounds**. The median is two, so that one is met. The other
two are not: the measured figures are 33.9% and 1.10×. All three come out of
`results/recourse.json` — `negotiator_share`, `lift` and `median_rounds` — rather than out of
this paragraph.

Two of those three had been reported and the rounds criterion had not, which is an omission
running against this project rather than for it. And the matrix is larger than the one
pre-registered — 270 policies where the ideation said 20 — generated from five fixed
parameters before the negotiator was tuned against them. Thirteen times the policies is a
harder test, not a softer one, but it is still a change to a pre-registered quantity, so it
is said here rather than left to be discovered. Negotiating is worth doing — it beats the baseline, and it is far better than doing
nothing — but by much less than the hypothesis claimed, and it is actively harmful against
merchants who penalise it.

**The grid weights parameter values uniformly**, which over-represents stonewalling
merchants relative to any real population: a third of them refuse every claim outright.
A grid weighted to a realistic merchant mix would report a higher number. That weighting
was fixed in advance and has not been revisited, which is the point of fixing it.

**The merchants are simulated.** No real merchant has implemented the recourse protocol.
These are policy-driven agents, not observations of real conduct, and they are only as
representative as the parameter space above.

**And they were perfectly predictable, which turns out to carry the result.**
`pnpm --filter @owed/eval robustness` re-runs the whole grid with each merchant's three
continuous parameters drawn from a seeded source instead of taken exactly — five seeds, two
jitter levels, four arms (all three parameters together, then each alone), and on top of that
two concession levers at three margins each. Every pass is a full 1,620-session grid.

The earlier version of this sentence said "41 passes", which counted the forty jitter arms and
the deterministic run and left out the eighteen concession passes the same command produces —
an understatement of its own work rather than an error, but the structure above is what it
actually does and does not go stale as passes are added. It does not touch the pre-registered
run; a test pins that the two are byte-identical when no variability is supplied.

| varying | jitter | negotiator | lift | beat the baseline |
|---|---|---|---|---|
| nothing (pre-registered) | — | 33.9% | **1.10×** | — |
| `concession_rate` | 0.25 | 33.9% | 1.10× | 5 of 5 |
| `anchor_ratio` | 0.25 | 31.7% | 1.04× | 5 of 5 |
| `accept_ratio` | 0.10 | 30.8% | 1.00× | 3 of 5 |
| `accept_ratio` | 0.25 | 30.0% | **0.97×** | 0 of 5 |
| all three | 0.10 | 29.0% | **0.95×** | 0 of 5 |
| all three | 0.25 | 27.4% | **0.90×** | 0 of 5 |

**Read that honestly: once a merchant's acceptance threshold is uncertain, arguing loses to
taking the first offer.** Not by much, and not in every cell, but the sign of the headline
result flips. H3's 1.10× is a figure about merchants who behave exactly as their parameters
say.

The decomposition says why, and it is not a general fact about negotiating. The negotiator
counters at exactly the reservation, and a merchant settles when the counter is at or below
`stated × accept_ratio` where `stated` *is* the reservation — so **90 of the 270 policies
settle at exact equality**, to the penny. Wobble that threshold down and those cells refuse
instead of settling at the full published figure; wobble it up and nothing improves, because
the negotiator never asks for more than the reservation. The effect is one-sided by
construction. `concession_rate` moves the result by about two hundredths of a percentage
point, because the counter arrives on the first reply and the merchant's later concession
schedule hardly ever comes into it.

So the strategy is knife-edged rather than wrong: asking for exactly the published figure
wins against a merchant who honours it exactly and loses the moment they do not.

**This section used to end by predicting the fix: that countering a little under the
reservation would trade a small amount of upside for a lot of robustness. It was never run,
and it is wrong.** Run now, over the same five seeds, with both the lever that was predicted
and one it missed — and with no default changed, which `robustness.test.ts` pins by asserting
the report is byte-identical when both margins are explicitly zero:

| conceding | deterministic | jitter 0.1 | jitter 0.25 | ever above 1.0 |
|---|---|---|---|---|
| nothing — the shipped negotiator | **1.103×** | 0.951× | 0.899× | — |
| `counterMargin` 2.5% | 1.087× | 0.960× | 0.915× | no |
| `counterMargin` 5% | 1.071× | 0.977× | 0.929× | no |
| `counterMargin` 10% | 1.038× | 0.988× | 0.959× | no |
| `acceptMargin` 2.5% | 1.103× | 0.951× | 0.899× | no |
| `acceptMargin` 5% | 1.103× | 0.951× | 0.899× | no |
| `acceptMargin` 10% | **1.103×** | 0.990× | 0.915× | no |

Three findings, none of them the predicted one:

1. **Asking for less trades roughly one for one.** `counterMargin` 10% costs 0.066 of lift
   deterministically and buys back 0.037 at jitter 0.1 and 0.060 at jitter 0.25. A fair
   swap, not "a little for a lot".
2. **No margin at either lever restores the result.** The best jittered figure anywhere in
   the table is 0.990×, from a 10% concession. The sign does not flip back, so conceding is
   not the fix — it is a slightly different shape of losing.
3. **The lever the prediction did not name is strictly better and still insufficient.**
   `acceptMargin` changes only what the negotiator will *take*, never what it asks, so the
   stance holds — it never asks for a number of its own invention — and it costs **exactly
   nothing** on the pre-registered grid, pinned by a test asserting the recovered total is
   identical. Below 10% it does nothing at all; at 10% it recovers 0.951× → 0.990×.

The reason both fall short is already in this document: a third of the grid refuses every
claim outright. There is nothing to concede *to* a merchant who offers nothing, and the
cells that flip under jitter flip from "settles at the published figure" to "refuses" — not
to "offers slightly less".

**The pre-registered negotiator is still the one every figure above was produced with**, and
both margins are zero in everything that ships. What changed is that the sentence predicting
otherwise has been replaced by the measurement that refutes it.

Numbers from `results/robustness.json`, seeds 1–5, listed in the file.

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

**The hypothesis is still not met on value.** H3 predicted ≥ 60% of owed, ≥ 1.5× the
baseline, and a median of ≤ 2 rounds; the rounds criterion is met and the other two are not.
Learning moves the result from 33.9% to 44.1% and from 1.10× to 1.43× — much closer, and
still short on both counts. A third of the grid refuses every claim outright and is
unrecoverable by anyone, which caps what any strategy can reach.

**Learning takes time a household may not have.** Three encounters with the same merchant
about the same kind of broken promise is a lot of broken promises. The figures above are an
upper bound on how quickly the loop pays off, not a description of a first month of use.
