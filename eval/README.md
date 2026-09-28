# Evaluation

Run it:

```bash
pnpm build
pnpm --filter @owed/eval recourse    # single-shot: does negotiating beat taking the first offer?
pnpm --filter @owed/eval learning    # repeat games: does knowing who you are arguing with help?
```

Results are written to `eval/results/recourse.json`, one row per session.

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
