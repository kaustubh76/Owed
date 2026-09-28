import type { Client } from "@modelcontextprotocol/client";
import { routeUtterance } from "./intents.js";
import type { ToolTrace, TurnMessage } from "./protocol.js";

/** What Owed says when it has no tool for what was asked. */
const FALLBACK =
  "I can tell you what you're owed, what's still open, and why I did or didn't file a claim.";

export class OwedBrain {
  readonly #client: Client;
  readonly #viewCache = new Map<string, string>();

  constructor(client: Client) {
    this.#client = client;
  }

  async turn(utterance: string): Promise<TurnMessage> {
    const intent = routeUtterance(utterance);
    if (!intent) {
      return { type: "turn", utterance, reply: FALLBACK, trace: [] };
    }

    const started = performance.now();
    const result = await this.#client.callTool({ name: intent.tool, arguments: intent.args });
    const ms = Math.round(performance.now() - started);

    const resourceUri = readResourceUri(result);
    const trace: ToolTrace[] = [
      {
        tool: intent.tool,
        args: intent.args,
        ms,
        isError: result.isError === true,
        ...(resourceUri === undefined ? {} : { resourceUri }),
      },
    ];

    const turn: TurnMessage = {
      type: "turn",
      utterance,
      // The spoken line comes from the tool, not from the brain. A voice-only device
      // and a screen device therefore hear exactly the same answer.
      reply: readSpokenText(result) ?? FALLBACK,
      trace,
    };

    if (resourceUri !== undefined) {
      const html = await this.#viewHtml(resourceUri);
      if (html !== undefined) turn.view = { uri: resourceUri, html, result };
    }

    return turn;
  }

  async #viewHtml(uri: string): Promise<string | undefined> {
    const cached = this.#viewCache.get(uri);
    if (cached !== undefined) return cached;

    const resource = await this.#client.readResource({ uri });
    const first = resource.contents[0] as { text?: string } | undefined;
    if (typeof first?.text !== "string") return undefined;

    this.#viewCache.set(uri, first.text);
    return first.text;
  }
}

function readSpokenText(result: unknown): string | undefined {
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
  const first = content?.find((block) => block.type === "text");
  return typeof first?.text === "string" ? first.text : undefined;
}

function readResourceUri(result: unknown): string | undefined {
  const meta = (result as { _meta?: { ui?: { resourceUri?: unknown } } })._meta;
  return typeof meta?.ui?.resourceUri === "string" ? meta.ui.resourceUri : undefined;
}
