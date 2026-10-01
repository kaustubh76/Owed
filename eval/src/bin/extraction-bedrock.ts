import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Extraction, ExtractionInput } from "@owed/extractor";
import { bedrockInvoke, createBedrockExtractor, DEFAULT_MODEL_ID } from "@owed/extractor-bedrock";
import { generateExtractionCorpus, type LabelledMessage } from "../extraction/corpus.js";
import { heldOutMessages } from "../extraction/heldout.js";
import { measureExtraction, scoreExtractions } from "../extraction/measure.js";

/**
 * H1, again, with a model — the measurement `packages/extractor/README.md` promises and
 * cannot make.
 *
 * That README has a section headed **"What it costs you to not use a model"** which then
 * answers the question rhetorically, because there was no model to compare against. This
 * script fills the gap, and publishes whichever way it falls.
 *
 *   OWED_BEDROCK_MODEL=amazon.nova-2-lite-v1:0 \
 *   AWS_REGION=us-east-1 pnpm --filter @owed/eval extraction:bedrock
 *
 * **Deliberately not part of `pnpm test` or `pnpm verify`.** `eval/src/extraction/corpus.test.ts`
 * asserts `report.false_alarms` is exactly `[]`, and CI runs `pnpm test` — so routing a
 * model through that assertion would make the build fail whenever the model read a promise
 * into one of the twenty-five messages that promise nothing. Not a flaky test: a correct
 * test of a non-deterministic thing, which is a worse problem. The rules extractor stays
 * the one the suite checks, and this is run by hand like the other evaluations.
 *
 * The rules column is recomputed here rather than read from `extraction.json`, so both
 * columns come from the same code in the same run and cannot drift apart.
 */
const MODEL_ID = process.env.OWED_BEDROCK_MODEL ?? DEFAULT_MODEL_ID;

/**
 * Sequential, not parallel.
 *
 * 160 calls is nothing, and on-demand Bedrock throttles per-account rather than per-call.
 * Firing them at once turns a five-minute run into a retry storm that reads like a model
 * failure. `bedrockInvoke` already backs off on `ThrottlingException`; going one at a time
 * means it rarely has to.
 */
async function runAll(
  messages: readonly LabelledMessage[],
  extract: (input: ExtractionInput) => Promise<Extraction[]>,
  label: string,
): Promise<Extraction[][]> {
  const out: Extraction[][] = [];
  for (const [index, item] of messages.entries()) {
    out.push(await extract(item.input));
    if ((index + 1) % 10 === 0) {
      process.stdout.write(`  ${label}: ${index + 1}/${messages.length}\n`);
    }
  }
  return out;
}

const dropped: Array<{ id: string; reasons: readonly string[] }> = [];
const extract = createBedrockExtractor({
  invoke: bedrockInvoke({ modelId: MODEL_ID }),
  onDropped: (input, reasons) => dropped.push({ id: input.id, reasons }),
});

process.stdout.write(`Promise extraction — H1 with a model\n  model: ${MODEL_ID}\n\n`);

const corpus = generateExtractionCorpus();
const held = heldOutMessages();

/**
 * Translate the three failures that actually happen into something worth reading.
 *
 * The SDK's own errors are accurate and useless here — a `CredentialsProviderError` stack
 * fourteen frames deep, printed after the run has already started, tells somebody who just
 * wanted a number nothing about what to do next. Each of these has exactly one fix, so the
 * message may as well name it.
 */
function explain(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);

  if (name === "CredentialsProviderError" || /Could not load credentials/.test(message)) {
    return "No AWS credentials. This evaluation calls Bedrock for real:\n  aws configure sso    # or aws configure\n  aws sts get-caller-identity";
  }
  if (name === "AccessDeniedException") {
    return `Credentials work, but this account cannot invoke ${MODEL_ID}. Two separate things are needed:\n  1. Model access, requested per-model per-region in the Bedrock console\n  2. An IAM policy allowing bedrock:InvokeModel on that model's ARN`;
  }
  if (name === "ValidationException" || name === "ResourceNotFoundException") {
    return `${MODEL_ID} was rejected by Bedrock in this region.\nCheck the id and that the model is offered in ${process.env.AWS_REGION ?? "(AWS_REGION unset)"}.\nAny Converse-compatible model works: OWED_BEDROCK_MODEL=<id>`;
  }
  return message;
}

let bedrockTuned: ReturnType<typeof scoreExtractions>;
let bedrockHeld: ReturnType<typeof scoreExtractions>;
try {
  bedrockTuned = scoreExtractions(corpus, await runAll(corpus, extract, "corpus"));
  bedrockHeld = scoreExtractions(held, await runAll(held, extract, "held out"));
} catch (error) {
  process.stderr.write(`\n✗ ${explain(error)}\n\nNothing was written.\n`);
  process.exit(1);
}

// Same scorer, same run — the only way the two columns are comparable.
const rulesTuned = measureExtraction(corpus);
const rulesHeld = measureExtraction(held);

const pct = (value: number | undefined) =>
  value === undefined ? "  —  " : `${(value * 100).toFixed(1)}%`;

const row = (label: string, rules: number | undefined, model: number | undefined) =>
  `  ${label.padEnd(30)} ${pct(rules).padStart(8)}   ${pct(model).padStart(8)}\n`;

process.stdout.write(`\n  ${"".padEnd(30)} ${"rules".padStart(8)}   ${"model".padStart(8)}\n`);
process.stdout.write(
  row(
    "tuned corpus, precision",
    rulesTuned.kind.overall.precision,
    bedrockTuned.kind.overall.precision,
  ),
);
process.stdout.write(
  row("tuned corpus, recall", rulesTuned.kind.overall.recall, bedrockTuned.kind.overall.recall),
);
process.stdout.write(
  row("held out, precision", rulesHeld.kind.overall.precision, bedrockHeld.kind.overall.precision),
);
process.stdout.write(
  row("held out, recall", rulesHeld.kind.overall.recall, bedrockHeld.kind.overall.recall),
);
process.stdout.write(
  row(
    "held out, exact precision",
    rulesHeld.exact.overall.precision,
    bedrockHeld.exact.overall.precision,
  ),
);
process.stdout.write(
  row("held out, exact recall", rulesHeld.exact.overall.recall, bedrockHeld.exact.overall.recall),
);

/**
 * The negatives, called out separately because they are what precision means here and the
 * README's rule is that the halves are never rolled together. A model reading a promise
 * into a marketing email is the failure that would make Owed file claims nobody was owed.
 */
process.stdout.write(
  `\n  false alarms on messages that promise nothing: rules ${rulesHeld.false_alarms.length}, model ${bedrockHeld.false_alarms.length}\n`,
);

/**
 * How often the model was caught inventing its evidence.
 *
 * Reported prominently because it is the number that says whether the guard is load-bearing
 * or theatre, and because it does not appear in any tally — a discarded extraction is
 * simply absent, so without this line a hallucinating model and a cautious one look alike.
 */
const invented = dropped.flatMap((d) => d.reasons).filter((r) => r.includes("not in the message"));
process.stdout.write(
  `  extractions discarded for inventing their evidence: ${invented.length}\n` +
    `  extractions discarded for any reason: ${dropped.flatMap((d) => d.reasons).length}\n`,
);

const dir = fileURLToPath(new URL("../../results/", import.meta.url));
mkdirSync(dir, { recursive: true });
writeFileSync(
  `${dir}extraction-bedrock.json`,
  `${JSON.stringify(
    {
      model: MODEL_ID,
      run_at: new Date().toISOString(),
      rules: { tuned: rulesTuned, held_out: rulesHeld },
      model_backed: { tuned: bedrockTuned, held_out: bedrockHeld },
      dropped,
    },
    null,
    2,
  )}\n`,
);

process.stdout.write(`\n  written to eval/results/extraction-bedrock.json\n`);
