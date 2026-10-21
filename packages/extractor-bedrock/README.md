# @owed/extractor-bedrock

**The same job as [`@owed/extractor`](../extractor), asked of a model instead of rules.**

Apache-2.0. Part of [Owed](../../readme.md).

---

## Why this is a separate package

`@owed/extractor` says on its first line that it is "rules, not a model", and again that it
runs with "no network and no AWS". Those are not slogans — its tests rely on them, it is
published on its own, and somebody choosing it is choosing determinism. Adding an SDK call
to it would have made all of that false in exchange for a comparison.

So the rules extractor is untouched and stays the default everywhere. This is a sibling,
used by one evaluation.

## It is not a drop-in replacement

`extractPromises` is synchronous:

```ts
extractPromises(input: ExtractionInput): Extraction[]
```

A model call cannot be, so this returns a promise:

```ts
createBedrockExtractor({ invoke }): (input: ExtractionInput) => Promise<Extraction[]>
```

That difference is why the evaluation harness grew a seam (`scoreExtractions`) rather than
taking a swapped-in function. Worth stating, because "same signature, drop it in" was the
assumption that made this look free.

## The evidence guard

`Extraction.evidence_text` is mandatory, and the rules extractor explains why:

> Nothing is extracted without one. A promise a household cannot trace back to a sentence
> somebody actually wrote them is a promise Owed invented.

A language model produces that sentence whether or not it exists. And the consequence is
concrete rather than theoretical: `quoteFor()` in the server's storyboard seed puts the
extractor's quote on the evidence card under the heading **they wrote**. A hallucinated
quote would be invented words attributed to a named company, shown to a household as
grounds for a claim for money.

So **every extraction is checked against the message it came from, and dropped if the
sentence is not there.** Whitespace is forgiven, because a model that re-wrapped a line it
copied correctly has invented nothing. Nothing else is.

The model therefore **fails closed**: inventing evidence costs recall, which the evaluation
reports, rather than buying confident fiction, which it would not. Note that the harness
does not score `evidence_text` at all — matching is on kind and exact timing — so the guard
earns nothing on the scoreboard and may well lower the numbers. It is here because the
product's guarantee is worth more than the measurement.

## Shape

One function does I/O. Everything else is pure, and tested.

| File | |
|---|---|
| `invoke.ts` | The port: `(prompt: string) => Promise<string>`. |
| `bedrock.ts` | The real adapter — Converse API, `OWED_BEDROCK_MODEL`, retry on throttling. Tested in `bedrock.test.ts` against a local server that speaks Converse over h2c, with a real `BedrockRuntimeClient` pointed at it: what reaches the wire, how the envelope is read back, and which failures are retried. What that cannot tell you is whether a model's answers are any good. |
| `prompt.ts` | `buildPrompt`. Pure. |
| `parse.ts` | `parseExtractions` — schema validation and the evidence guard. Pure. |
| `extract.ts` | `createBedrockExtractor`. |

That split is the same one `MerchantDirectory` uses to keep a real network peer and a
deterministic stand-in behind one port. It also mirrors `DynamoEventStore`'s injectable
client, and the difference between them turned out to be smaller than this file used to
claim. There is no local Bedrock the way there is a DynamoDB Local — but a
`BedrockRuntimeClient` takes an `endpoint`, so the adapter is verifiable offline anyway,
against a server that speaks Converse. The part that genuinely needs the real service is
not the adapter. It is the model.

## Running it

Not part of `pnpm test` or `pnpm verify`, deliberately.
`eval/src/extraction/corpus.test.ts` asserts that nothing is read out of the twenty-five
messages that promise nothing — `expect(report.false_alarms).toEqual([])` — and CI runs
`pnpm test`. A model behind that assertion would fail the build whenever it misread one
message. Not a flaky test; a correct test of a non-deterministic thing, which is worse.

```bash
AWS_REGION=us-east-1 pnpm --filter @owed/eval extraction:bedrock
```

Needs `bedrock:InvokeModel` on that
model's ARN — two separate things, and the console request has a wait. The policy is written
out in `deploy/iam-policy-bedrock.json`, minimal and attached to nothing; `deploy/README.md`
explains why it carries two resource ARNs for one model. Results land in
`eval/results/extraction-bedrock.json` with both columns from the same run.

## Numbers

None yet. **No model has ever run**: the access is a console request, and until it lands
there are no extraction figures to report.

Be careful about what that does and does not leave unverified, because this section used to
overstate it. The wiring is tested — `bedrock.test.ts` points a real `BedrockRuntimeClient`
at a local `node:http2` server speaking Converse over h2c and asserts what reaches the wire,
how the envelope is read back, and which failures are retried. What is untested is the one
thing a local server cannot stand in for: whether a real model, given this prompt, returns
promises this parser can read. That is the gap, and it is narrower than "the wiring is
unverified" claimed.

Everything either side of that call is tested: the prompt, the parser, the evidence guard
and the failure modes, against fakes, with no credentials.
