import type { Client } from "@modelcontextprotocol/client";
import type { CommitmentEvent } from "@owed/mcp-server";
import { routeUtterance } from "./intents.js";
import type { ProactiveMessage, ToolTrace, TurnMessage } from "./protocol.js";

/** What Owed says when it has no tool for what was asked. */
const FALLBACK =
  "I can tell you what you're owed, what's still open, and why I did or didn't file a claim.";

export class OwedBrain {
  readonly #client: Client;
  readonly #viewCache = new Map<string, string>();
  /**
   * The promise currently under discussion.
   *
   * "File it" is meaningless on its own; it means the thing just mentioned. The brain
   * keeps that reference so the household can speak the way people actually do.
   */
  #focus: string | undefined;
  /** The promise Owed decided not to claim, which is a different question. */
  #declined: string | undefined;

  constructor(client: Client) {
    this.#client = client;
  }

  get focus(): string | undefined {
    return this.#focus;
  }

  async turn(utterance: string): Promise<TurnMessage> {
    const intent = routeUtterance(utterance);
    if (!intent) {
      return { type: "turn", utterance, reply: FALLBACK, trace: [] };
    }

    const args = { ...intent.args };
    if (intent.needsFocus !== undefined) {
      const subject = intent.needsFocus === "declined" ? this.#declined : this.#focus;
      if (subject === undefined) {
        return { type: "turn", utterance, reply: NOTHING_IN_MIND, trace: [] };
      }
      args.promise_id = subject;
    }

    const started = performance.now();
    const result = await this.#client.callTool({ name: intent.tool, arguments: args });
    const ms = Math.round(performance.now() - started);
    this.#rememberFocus(result);

    const resourceUri = readResourceUri(result);
    const trace: ToolTrace[] = [
      {
        tool: intent.tool,
        args,
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

  /**
   * Speak first, about something nobody asked about.
   *
   * The spoken line is the announcement's own, never a tool's: a tool answers a
   * question, and this is an interruption, which has to carry its own reason for
   * happening. The card is fetched afterwards purely so a screen has something to show.
   *
   * Fetching it also leaves the promise in focus, which is what makes the next thing
   * the household says work: after "Northwind Parcel missed the delivery window, shall
   * I file it?", "file it" has to mean that one.
   */
  async announce(event: CommitmentEvent): Promise<ProactiveMessage> {
    const message: ProactiveMessage = { type: "proactive", event, reply: event.spoken };

    const call = cardCallFor(event);
    if (call === undefined) return message;

    try {
      const result = await this.#client.callTool(call);
      this.#rememberFocus(result);

      const uri = readResourceUri(result);
      if (uri === undefined) return message;
      const html = await this.#viewHtml(uri);
      if (html !== undefined) message.view = { uri, html, result };
    } catch {
      // A card that cannot be drawn must never silence the announcement. Voice is the
      // surface that always exists.
    }
    return message;
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

  /**
   * Keep hold of whichever promise the household is most likely to mean next.
   *
   * A claim or an evidence card is about one promise. A ledger summary is about many, so
   * the one worth remembering is the one waiting on an answer.
   */
  #rememberFocus(result: unknown): void {
    const data = (result as { structuredContent?: Record<string, unknown> }).structuredContent;
    if (data === undefined) return;

    // A card about one promise says which slot it belongs in. Explaining why something
    // was *not* claimed must never make it the thing "file it" then tries to file.
    if (typeof data.promise_id === "string" && typeof data.status === "string") {
      if (data.status === "Breached") this.#focus = data.promise_id;
      else if (data.status === "Suspected") this.#declined = data.promise_id;
      return;
    }
    if (typeof data.promise_id === "string") return;

    const items = data.items;
    if (!Array.isArray(items)) return;
    const withStatus = (status: string) =>
      items.find(
        (item): item is { promise_id: string } =>
          typeof item === "object" &&
          item !== null &&
          (item as { status?: unknown }).status === status,
      );

    const waiting = withStatus("Breached");
    if (waiting !== undefined) this.#focus = waiting.promise_id;
    const declined = withStatus("Suspected");
    if (declined !== undefined) this.#declined = declined.promise_id;
  }
}

/** The read that draws the card for an announcement. Voice-only events have none. */
function cardCallFor(
  event: CommitmentEvent,
): { name: string; arguments: Record<string, unknown> } | undefined {
  if (event.kind === "promise_breached") {
    return { name: "promise_check", arguments: { promise_id: event.subject.promise_id } };
  }
  if (event.subject.claim_id !== undefined) {
    return { name: "claim_status", arguments: { claim_id: event.subject.claim_id } };
  }
  return undefined;
}

const NOTHING_IN_MIND =
  "Tell me which promise you mean, or ask me what you're owed and I'll bring one up.";

function readSpokenText(result: unknown): string | undefined {
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
  const first = content?.find((block) => block.type === "text");
  return typeof first?.text === "string" ? first.text : undefined;
}

function readResourceUri(result: unknown): string | undefined {
  const meta = (result as { _meta?: { ui?: { resourceUri?: unknown } } })._meta;
  return typeof meta?.ui?.resourceUri === "string" ? meta.ui.resourceUri : undefined;
}
