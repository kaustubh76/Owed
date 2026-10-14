import {
  createServer,
  type Http2Server,
  type IncomingHttpHeaders,
  type ServerHttp2Stream,
} from "node:http2";
import type { AddressInfo } from "node:net";
import {
  BedrockRuntimeClient,
  ThrottlingException,
  ValidationException,
} from "@aws-sdk/client-bedrock-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { bedrockInvoke, DEFAULT_MODEL_ID } from "./bedrock.js";

/**
 * The Bedrock adapter, against a real `BedrockRuntimeClient` pointed at a local server.
 *
 * `invoke.ts` says this file is the one that "cannot be verified offline", and that was
 * the wrong conclusion from a true premise. There is no Bedrock to run locally the way
 * DynamoDB Local runs — but the client takes an `endpoint`, so the real SDK can be pointed
 * somewhere that speaks Converse, and then everything in the adapter is observable: what
 * it puts on the wire, how it reads an envelope back, and which failures it retries.
 *
 * That last one is why a hand-made error object would not do. The retry turns on
 * `error instanceof ThrottlingException`, which only holds for an exception the SDK itself
 * deserialised from a response — so the server answers with the status and the
 * `x-amzn-errortype` header the real service sends, and the SDK constructs the class. A
 * test that threw a fake would pass while the production branch did nothing.
 *
 * Two things were measured here rather than assumed, both of which changed the code or
 * the test: the SDK speaks **HTTP/2** to this service, so a `node:http` server fails the
 * handshake with `ERR_HTTP2_ERROR` before any assertion runs; and the SDK carries its own
 * retry policy, three attempts by default, which used to sit underneath the adapter's own
 * loop. See the note on `maxAttempts` in `bedrock.ts`.
 *
 * What none of this establishes is whether the model's answers are any good. That needs
 * the real service, and `eval/` is where it is asked.
 */

/** One scripted reply. `text` blocks become a Converse envelope; the rest are errors. */
type Reply =
  | { kind: "blocks"; blocks: Array<{ text?: string }> }
  | { kind: "throttle" }
  | { kind: "invalid" };

interface Fake {
  readonly url: string;
  /** Every request the SDK actually sent, in order. */
  readonly requests: Array<{ path: string; body: unknown }>;
  close(): Promise<void>;
}

function respond(stream: ServerHttp2Stream, reply: Reply): void {
  if (reply.kind === "blocks") {
    stream.respond({ ":status": 200, "content-type": "application/json" });
    stream.end(
      JSON.stringify({
        output: { message: { role: "assistant", content: reply.blocks } },
        stopReason: "end_turn",
      }),
    );
    return;
  }

  // The status and `x-amzn-errortype` the real service sends, so the SDK builds the real
  // exception class rather than a generic `ServiceException`.
  const type = reply.kind === "throttle" ? "ThrottlingException" : "ValidationException";
  stream.respond({
    ":status": reply.kind === "throttle" ? 429 : 400,
    "content-type": "application/json",
    "x-amzn-errortype": type,
  });
  stream.end(JSON.stringify({ __type: type, message: `${type} from the fake` }));
}

/**
 * A Converse endpoint that answers from a script.
 *
 * The script is consumed in order; the last entry repeats, so "throttle for ever" is one
 * entry rather than a count that has to match the retry budget.
 */
async function fakeBedrock(script: Reply[]): Promise<Fake> {
  const requests: Array<{ path: string; body: unknown }> = [];
  const server: Http2Server = createServer();

  server.on("stream", (stream: ServerHttp2Stream, headers: IncomingHttpHeaders) => {
    let raw = "";
    stream.on("data", (chunk) => {
      raw += chunk;
    });
    stream.on("end", () => {
      requests.push({ path: String(headers[":path"]), body: JSON.parse(raw) });
      const reply = script[Math.min(requests.length - 1, script.length - 1)];
      respond(stream, reply ?? { kind: "invalid" });
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

const open: Fake[] = [];

/** The real client, pointed at the fake. Credentials are required to sign and unused. */
function clientFor(fake: Fake): BedrockRuntimeClient {
  return new BedrockRuntimeClient({
    region: "us-east-1",
    endpoint: fake.url,
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
    // So the server's request count measures the adapter's retry loop and not the SDK's.
    maxAttempts: 1,
  });
}

async function serving(script: Reply[]): Promise<Fake> {
  const fake = await fakeBedrock(script);
  open.push(fake);
  return fake;
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((fake) => fake.close()));
});

describe("what the adapter puts on the wire", () => {
  it("asks the configured model, at temperature zero", async () => {
    const fake = await serving([{ kind: "blocks", blocks: [{ text: "Tuesday" }] }]);
    const invoke = bedrockInvoke({ client: clientFor(fake) });

    expect(await invoke("when is it due")).toBe("Tuesday");

    const sent = fake.requests[0];
    expect(sent?.path).toBe(`/model/${encodeURIComponent(DEFAULT_MODEL_ID)}/converse`);
    expect(sent?.body).toStrictEqual({
      messages: [{ role: "user", content: [{ text: "when is it due" }] }],
      inferenceConfig: { maxTokens: 2048, temperature: 0 },
    });
  });

  it("asks a different model when told to, by id and not by alias", async () => {
    const fake = await serving([{ kind: "blocks", blocks: [{ text: "ok" }] }]);
    const invoke = bedrockInvoke({
      client: clientFor(fake),
      modelId: "anthropic.claude-sonnet-4-5-v1:0",
    });

    await invoke("anything");

    // The whole point of the Converse API here: swapping the model changes one string.
    expect(fake.requests[0]?.path).toBe(
      `/model/${encodeURIComponent("anthropic.claude-sonnet-4-5-v1:0")}/converse`,
    );
  });

  it("defaults to Nova 2 Lite", () => {
    expect(DEFAULT_MODEL_ID).toBe("amazon.nova-2-lite-v1:0");
  });
});

describe("reading the envelope back", () => {
  /**
   * The reason the adapter joins the blocks instead of taking the first one. A model that
   * emits anything before its answer — a reasoning block, a preamble — would otherwise
   * have its answer silently dropped, and the extractor would see a prompt it could not
   * parse rather than an answer it could.
   */
  it("keeps the answer when the model says something before it", async () => {
    const fake = await serving([
      {
        kind: "blocks",
        blocks: [{ text: "Let me think. " }, {}, { text: "Delivery was promised Tuesday." }],
      },
    ]);

    expect(await bedrockInvoke({ client: clientFor(fake) })("when")).toBe(
      "Let me think. Delivery was promised Tuesday.",
    );
  });

  it("trims, because a model's leading newline is not part of the answer", async () => {
    const fake = await serving([{ kind: "blocks", blocks: [{ text: "\n  Tuesday\n" }] }]);

    expect(await bedrockInvoke({ client: clientFor(fake) })("when")).toBe("Tuesday");
  });

  /**
   * An empty reply is a failure, not an empty answer. Returning "" would reach the parser
   * as a malformed reply and be reported as a model that said something unparseable,
   * which is a worse error message than the true one.
   */
  it("refuses a reply with no text in it, and names the model", async () => {
    for (const blocks of [[], [{}], [{ text: "" }], [{ text: "   " }]]) {
      const fake = await serving([{ kind: "blocks", blocks }]);
      await expect(bedrockInvoke({ client: clientFor(fake) })("x")).rejects.toThrow(
        `${DEFAULT_MODEL_ID} returned no text content`,
      );
    }
  });
});

describe("which failures are worth trying again", () => {
  it("retries a throttle and returns the answer it eventually gets", async () => {
    const fake = await serving([
      { kind: "throttle" },
      { kind: "blocks", blocks: [{ text: "Tuesday" }] },
    ]);

    expect(await bedrockInvoke({ client: clientFor(fake), maxRetries: 2 })("when")).toBe("Tuesday");
    expect(fake.requests).toHaveLength(2);
  });

  it("gives up after maxRetries and rethrows the throttle itself", async () => {
    const fake = await serving([{ kind: "throttle" }]);

    await expect(
      bedrockInvoke({ client: clientFor(fake), maxRetries: 1 })("when"),
    ).rejects.toBeInstanceOf(ThrottlingException);

    // One attempt plus one retry. The caller sees the service's own error, not a wrapper,
    // because "Bedrock is throttling you" is the thing worth reading.
    expect(fake.requests).toHaveLength(2);
  });

  /**
   * Zero really is zero.
   *
   * It did not used to be: the adapter built its default client with the SDK's own retry
   * policy left at three attempts, so `maxRetries: 0` still sent three requests. That is
   * not visible from reading this function — it is a default two layers down — and it is
   * why the client this test injects pins `maxAttempts: 1` and why the adapter's own
   * default now does too.
   */
  it("sends exactly one request when retries are disabled", async () => {
    const fake = await serving([{ kind: "throttle" }]);

    await expect(
      bedrockInvoke({ client: clientFor(fake), maxRetries: 0 })("when"),
    ).rejects.toBeInstanceOf(ThrottlingException);
    expect(fake.requests).toHaveLength(1);
  });

  /**
   * Everything that is not a throttle fails the same way on every attempt — no model
   * access, a bad model id, malformed credentials — so retrying only delays a message
   * somebody needs to read.
   */
  it("does not retry a validation error, however many retries are allowed", async () => {
    const fake = await serving([{ kind: "invalid" }]);

    await expect(
      bedrockInvoke({ client: clientFor(fake), maxRetries: 4 })("when"),
    ).rejects.toBeInstanceOf(ValidationException);
    expect(fake.requests).toHaveLength(1);
  });

  /** The refusal above is the adapter's own, so it must not be retried either. */
  it("does not retry its own empty-reply refusal", async () => {
    const fake = await serving([{ kind: "blocks", blocks: [{ text: "" }] }]);

    await expect(bedrockInvoke({ client: clientFor(fake), maxRetries: 4 })("when")).rejects.toThrow(
      /returned no text content/,
    );
    expect(fake.requests).toHaveLength(1);
  });
});

/**
 * The client the adapter builds for itself, which is the one production uses.
 *
 * Every test above injects a client, so none of them can see the defaults the adapter
 * chooses — and the defect worth catching here lived in exactly that gap. The SDK honours
 * `AWS_ENDPOINT_URL_BEDROCK_RUNTIME`, so the un-injected path can be pointed at the fake
 * too, and the request count then measures the real thing.
 */
describe("the client the adapter builds when it is not given one", () => {
  /** Set for one test and put back exactly, including keys that were absent. */
  function withEnv<T>(vars: Record<string, string>, body: () => Promise<T>): Promise<T> {
    const previous = new Map(Object.keys(vars).map((key) => [key, process.env[key]]));
    Object.assign(process.env, vars);
    return body().finally(() => {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
  }

  it("leaves the retrying to maxRetries instead of doubling it with the SDK's own", async () => {
    const fake = await serving([{ kind: "throttle" }]);

    await withEnv(
      {
        AWS_ENDPOINT_URL_BEDROCK_RUNTIME: fake.url,
        AWS_REGION: "us-east-1",
        AWS_ACCESS_KEY_ID: "test",
        AWS_SECRET_ACCESS_KEY: "test",
      },
      async () => {
        await expect(bedrockInvoke({ maxRetries: 0 })("when")).rejects.toBeInstanceOf(
          ThrottlingException,
        );
      },
    );

    // Three, before the adapter pinned `maxAttempts: 1` on the client it builds — which is
    // what made "zero disables" untrue in the only configuration that ships.
    expect(fake.requests).toHaveLength(1);
  });

  it("takes the model id from OWED_BEDROCK_MODEL when there is one", async () => {
    const fake = await serving([{ kind: "blocks", blocks: [{ text: "ok" }] }]);

    await withEnv(
      {
        OWED_BEDROCK_MODEL: "amazon.nova-2-pro-v1:0",
        AWS_ENDPOINT_URL_BEDROCK_RUNTIME: fake.url,
        AWS_REGION: "us-east-1",
        AWS_ACCESS_KEY_ID: "test",
        AWS_SECRET_ACCESS_KEY: "test",
      },
      () => bedrockInvoke()("when"),
    );

    expect(fake.requests[0]?.path).toBe(
      `/model/${encodeURIComponent("amazon.nova-2-pro-v1:0")}/converse`,
    );
  });
});
