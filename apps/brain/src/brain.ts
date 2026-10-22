import type { PromiseStatus } from "@owed/domain";
import type { CommitmentEvent } from "@owed/mcp-server";
import { routeUtterance } from "./intents.js";
import type { ProactiveMessage, ToolTrace, TurnMessage } from "./protocol.js";
import type { SessionHandle } from "./session.js";

/** What Owed says when it has no tool for what was asked. */
const FALLBACK =
  "I can tell you what you're owed, what's still open, and why I did or didn't file a claim.";

/**
 * The two statuses the brain routes on, typed by the schema that declares them.
 *
 * These were bare string literals compared against an untyped `data.status`, which is the
 * same failure as a label map keyed by `string`: `"Breeched"` compiled, the branch never
 * fired, and nothing said so. `@owed/domain` was already a declared dependency of this app
 * and imported nowhere, so the type that fixes it was one import away the whole time.
 *
 * `satisfies PromiseStatus` rather than a plain annotation, so the constant keeps its literal
 * type and the comparisons below still narrow.
 */
const BREACHED = "Breached" satisfies PromiseStatus;
const SUSPECTED = "Suspected" satisfies PromiseStatus;

export class OwedBrain {
  /**
   * A way to reach a session, not a session.
   *
   * The session is rebuilt when a token expires or the server restarts, and the brain must
   * survive that **without losing `#focus`** — otherwise a reconnect silently turns "file
   * it" into "file what?", which is a worse bug than the disconnection it followed.
   */
  readonly #session: SessionHandle;
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
  /**
   * The promise Owed is not watching at all, which is a third question.
   *
   * Without this slot the state was unreachable. `promise_check` is only ever called through
   * `needsFocus`, and the two slots above are set from `Breached` and `Suspected` — an
   * unwatched promise is `Captured`, so no utterance and no chip could open it. The card
   * state and the spoken line existed, were tested, and could not be got to from the home.
   */
  #unwatched: string | undefined;

  constructor(session: SessionHandle) {
    this.#session = session;
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
      const subject =
        intent.needsFocus === "declined"
          ? this.#declined
          : intent.needsFocus === "unwatched"
            ? this.#unwatched
            : this.#focus;
      if (subject === undefined) {
        return { type: "turn", utterance, reply: NOTHING_IN_MIND, trace: [] };
      }
      args.promise_id = subject;
    }

    return this.#call(utterance, intent.tool, args);
  }

  /**
   * Answer an announcement's `offer` by calling the tool it names, with its arguments.
   *
   * Words go through `turn()` and resolve against `#focus`, which is right for voice: on an
   * Echo Dot there is no button, "file it" means the thing just mentioned, and `announce()`
   * holding focus is what makes that work. A *press on a specific offer* is a different act.
   * It already carries its subject, so re-deriving one from the words threw away the only
   * unambiguous thing about it — and left the hero beat depending on whichever announcement
   * had moved focus last. `scripts/verify-ui.mjs` says so in its own comment: mid-burst, "the
   * 'file it' below then refers to whatever the brain's focus happened to be, which may be a
   * recovered claim with nothing to file".
   *
   * The tool is checked against what the session actually advertises, not against a list kept
   * here. The home is not a hostile client, but a message that names a tool is a message that
   * can name the wrong one, and `tools/list` is the only authority on what exists.
   */
  async answerOffer(offer: {
    utterance: string;
    tool: string;
    arguments: Record<string, unknown>;
  }): Promise<TurnMessage> {
    const { tools } = await this.#session.call((client) => client.listTools());
    if (!tools.some((advertised) => advertised.name === offer.tool)) {
      return {
        type: "turn",
        utterance: offer.utterance,
        reply: FALLBACK,
        trace: [],
      };
    }
    return this.#call(offer.utterance, offer.tool, { ...offer.arguments });
  }

  /** One tool call, its trace, its spoken line and its card — however the turn was reached. */
  async #call(
    utterance: string,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<TurnMessage> {
    const started = performance.now();
    const result = await this.#session.call((client) =>
      client.callTool({ name: tool, arguments: args }),
    );
    const ms = Math.round(performance.now() - started);
    this.#rememberFocus(result);

    const resourceUri = readResourceUri(result);
    const trace: ToolTrace[] = [
      {
        tool,
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
      /**
       * Called even when the event declares no card, because this is the call that leaves the
       * promise in focus — and "file it" has to work on a device with no screen at all.
       */
      const result = await this.#session.call((client) => client.callTool(call));
      this.#rememberFocus(result);

      /**
       * The card the **event** names, which is the whole of what `resource_uri` is for.
       *
       * This used to read the uri off the tool result instead, which meant Owed decided the
       * card twice: once in `proactive/scheduler.ts`, where every event declares a
       * `resource_uri`, and once here, from whichever tool `cardCallFor` picked. Two
       * definitions in two packages, agreeing only because both were written to — and the
       * event's half was read by nothing at all, in a schema `docs/proactive.md` publishes as
       * a proposal with a paragraph on why a host needs this field.
       *
       * Absent is not an oversight, it is a producer saying voice is enough — the schema says
       * so in as many words — and the old path would have drawn a card anyway. Unreachable in
       * this repository, where the scheduler sets it on all three kinds, and that is exactly
       * the kind of unreachable that stops being unreachable in somebody else's producer.
       *
       * The two are asserted equal for every kind in `proactiveTurn.test.ts`, so a card fed
       * another card's data cannot ship. If it ever did, `useOwedView` already answers it:
       * "Owed sent something this card could not read."
       */
      const declared = event.resource_uri;
      if (declared === undefined) return message;

      const html = await this.#viewHtml(declared);
      if (html !== undefined) message.view = { uri: declared, html, result };
    } catch {
      // A card that cannot be drawn must never silence the announcement. Voice is the
      // surface that always exists.
    }
    return message;
  }

  async #viewHtml(uri: string): Promise<string | undefined> {
    const cached = this.#viewCache.get(uri);
    if (cached !== undefined) return cached;

    const resource = await this.#session.call((client) => client.readResource({ uri }));
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
      // `watched === false` outranks the status, because an unwatched promise's status is
      // `Captured` — which says only that the read was confident, not that anything is
      // looking at it.
      if (data.watched === false) this.#unwatched = data.promise_id;
      else if (data.status === BREACHED) this.#focus = data.promise_id;
      else if (data.status === SUSPECTED) this.#declined = data.promise_id;
      return;
    }
    if (typeof data.promise_id === "string") return;

    const items = data.items;
    if (!Array.isArray(items)) return;
    const withStatus = (status: PromiseStatus) =>
      items.find(
        (item): item is { promise_id: string } =>
          typeof item === "object" &&
          item !== null &&
          (item as { status?: unknown }).status === status,
      );

    const waiting = withStatus(BREACHED);
    if (waiting !== undefined) this.#focus = waiting.promise_id;
    const declined = withStatus(SUSPECTED);
    if (declined !== undefined) this.#declined = declined.promise_id;

    // Picked off the ledger by the field rather than by status, which is why
    // `LedgerSummaryItem` carries it: asking "what am I owed?" is what puts an unwatched
    // promise in mind, and the item is the only place the household's own summary says so.
    const unwatched = items.find(
      (item): item is { promise_id: string } =>
        typeof item === "object" &&
        item !== null &&
        (item as { watched?: unknown }).watched === false &&
        typeof (item as { promise_id?: unknown }).promise_id === "string",
    );
    if (unwatched !== undefined) this.#unwatched = unwatched.promise_id;
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
