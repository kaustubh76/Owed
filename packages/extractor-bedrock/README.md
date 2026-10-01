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
| `bedrock.ts` | The real adapter — Converse API, `OWED_BEDROCK_MODEL`, retry on throttling. **The only file here with no tests**, because there is no local Bedrock to point it at. |
| `prompt.ts` | `buildPrompt`. Pure. |
| `parse.ts` | `parseExtractions` — schema validation and the evidence guard. Pure. |
| `extract.ts` | `createBedrockExtractor`. |

That split is the same one `MerchantDirectory` uses to keep a real network peer and a
deterministic stand-in behind one port. It also mirrors `DynamoEventStore`'s injectable
client — with one honest difference: DynamoDB Local makes that adapter verifiable offline,
and nothing equivalent exists for Bedrock.

## Running it

Not part of `pnpm test` or `pnpm verify`, deliberately.
`eval/src/extraction/corpus.test.ts` asserts that nothing is read out of the twenty-five
messages that promise nothing — `expect(report.false_alarms).toEqual([])` — and CI runs
`pnpm test`. A model behind that assertion would fail the build whenever it misread one
message. Not a flaky test; a correct test of a non-deterministic thing, which is worse.

```bash
AWS_REGION=us-east-1 pnpm --filter @owed/eval extraction:bedrock
```

Needs model access requested in the Bedrock console and `bedrock:InvokeModel` on that
model's ARN — two separate things, and the console request has a wait. Results land in
`eval/results/extraction-bedrock.json` with both columns from the same run.

## Numbers

None yet. Nothing in this package has run against Bedrock — the model access is a console
request, and until it lands the honest statement is that the wiring in `bedrock.ts` is
unverified and there are no results to report.

Everything either side of that call is tested: the prompt, the parser, the evidence guard
and the failure modes, against fakes, with no credentials.
