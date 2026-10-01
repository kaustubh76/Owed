import {
  BedrockRuntimeClient,
  ConverseCommand,
  ThrottlingException,
} from "@aws-sdk/client-bedrock-runtime";
import type { Invoke } from "./invoke.js";

/**
 * Nova 2 Lite, the choice the ideation document already made and the one with the better
 * story for an Amazon hackathon.
 *
 * Overridable because everything here goes through the Converse API, so any
 * Converse-compatible model works unchanged — including a Claude model on Bedrock if Nova
 * underperforms. That keeps "which model" out of the critical path: the console access
 * request has a wait, and it would be a poor reason to hold up the rest of the work.
 */
export const DEFAULT_MODEL_ID = "amazon.nova-2-lite-v1:0";

export interface BedrockInvokeOptions {
  client?: BedrockRuntimeClient;
  modelId?: string;
  /** Retries on throttling only. Zero disables. */
  maxRetries?: number;
}

/**
 * The real adapter, and the only file in this package that cannot be tested here.
 *
 * `client` is injectable for the same reason `DynamoEventStore` takes one: so a caller can
 * point this somewhere else without the adapter knowing anything about endpoints or
 * credentials. There is no local Bedrock to point it at, though, which is the honest
 * difference between this file and that one — DynamoDB Local made the storage adapter
 * verifiable offline, and nothing equivalent exists here. Everything it is built on is
 * tested; the wiring in this file is not, until it runs against the real service.
 *
 * **Temperature 0.** Not for reproducibility — a model is not deterministic and pretending
 * otherwise is how a flaky evaluation gets published — but because sampling buys nothing
 * when the task is reading a date out of a sentence.
 */
export function bedrockInvoke({
  client,
  modelId = process.env.OWED_BEDROCK_MODEL ?? DEFAULT_MODEL_ID,
  maxRetries = 4,
}: BedrockInvokeOptions = {}): Invoke {
  const runtime = client ?? new BedrockRuntimeClient({});

  return async (prompt: string) => {
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await runtime.send(
          new ConverseCommand({
            modelId,
            messages: [{ role: "user", content: [{ text: prompt }] }],
            inferenceConfig: { temperature: 0, maxTokens: 2048 },
          }),
        );

        // The envelope is content blocks, and only some carry text. Concatenated rather
        // than taking the first, because a model that emits a reasoning block before the
        // answer would otherwise lose the answer.
        const text = (response.output?.message?.content ?? [])
          .map((block) => block.text ?? "")
          .join("")
          .trim();

        if (text === "") throw new Error(`${modelId} returned no text content`);
        return text;
      } catch (error) {
        // Throttling is the expected failure at 160 sequential calls, and it is the one
        // worth retrying: everything else — no model access, a bad model id, malformed
        // credentials — fails the same way on every attempt, and retrying it only delays a
        // message somebody needs to read.
        if (!(error instanceof ThrottlingException) || attempt >= maxRetries) throw error;
        await delay(2 ** attempt * 500 + Math.random() * 250);
      }
    }
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
