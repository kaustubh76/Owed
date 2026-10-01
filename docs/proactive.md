# Speaking first

*A feature request for Alexa+ add-ons, written as a schema.*

## The gap

Alexa+ add-ons are strictly reactive. A tool runs because somebody said something. There
is no way for an add-on to raise anything on its own — no scheduled wake, no event
channel, nothing that reaches a device unless a person started the exchange.

For most add-ons that is a limitation. For Owed it removes the product.

Owed exists to notice what the household did **not** ask about. A parcel that never came,
a refund that never landed, a claim window closing on Thursday. The moment that only
works if somebody thinks to ask is the moment the product is worth nothing: people do not
wake up wondering whether a courier honoured a delivery guarantee eleven days ago. That
is precisely the work they want handed off.

So the one primitive Owed needs is the one that does not exist.

## The shape we would need

`CommitmentEvent`, defined in
[`packages/mcp-server/src/proactive/commitment.ts`](../packages/mcp-server/src/proactive/commitment.ts)
as a real zod schema rather than a paragraph in a feedback form. Nothing in it is a guess
at a private API. These are the fields a host would actually need in order to decide
whether to interrupt somebody.

| Field | Why a host needs it |
|---|---|
| `event_id` | Deterministic, derived from the subject. A host sees the same event on every poll until it acts, and a ledger can be replayed — an event needs an identity that survives both. Two announcements about one broken promise is a bug the household hears. |
| `occurred_at` | When the thing became true, not when the add-on noticed. |
| `expires_at` | **After this, say nothing.** Proactive speech has to be allowed to go stale. Being told on Friday about a parcel that failed on Sunday is worse than silence. |
| `urgency` | Whether this is worth interrupting for. Only the add-on knows whether money is about to stop being recoverable. |
| `spoken` | A self-sufficient line, under the same voice rules as any tool result. |
| `subject` | What it is about, so a host can group or suppress. |
| `resource_uri` | The card to render where there is a screen. Absent is legitimate: voice is enough. |
| `offer` | What the household can say next, and the tool it maps to. Without this an announcement is a dead end — somebody hears that something is wrong and has to work out for themselves how to ask for it to be fixed. |

## What we built instead

A **projection, not a queue**:

```
GET /control/commitments → { now, events: CommitmentEvent[] }
```

*(Unauthenticated on a loopback demo, which is where it belongs. Set `OWED_CONTROL_TOKEN`
and it requires a bearer token — the `spoken` line names a merchant and an amount, so this
is a ledger read, and the deployed Caddyfile does not proxy `/control/*` at all. See
readme §12.2.)*

Everything Owed would say unprompted at the instant on the clock, derived from the
ledger. That choice matters more than it looks. The timeline scrubber moves scenario time
in both directions, and a queue would either replay announcements on the way back or lose
them on the way forward. Derived from state, the answer for a given instant is always the
same answer.

The endpoint sits **outside the MCP surface** on purpose. It is not part of the add-on
contract — it is the shape of the request we are making of it, and it lives next to the
scrubber's clock control for the same reason.

The simulated home's brain polls it, announces what has newly fallen due, and badges
every one of them `simulated proactive`. The protocol inspector shows each
`CommitmentEvent` on its own channel. A judge can read the exact shape Amazon would have
to emit, on the wire, in context.

## Rules the scheduler keeps

- **Never speak about a `Suspected` verdict.** Owed refuses to act when it did not see
  enough, and speaking first without being asked is the last place to start guessing.
- **Never raise a promise already filed.** The household knows.
- **A host that has just come up does not read out the backlog.** The first poll records
  what is already true without saying any of it.
- **Announcements go stale.** Three days, then dropped rather than queued. That number is
  a judgement, not a measurement — long enough to survive a weekend away, short enough
  that nothing stale is ever spoken. A merchant that published its own claim window would
  override it, and none of ours do.

## Honestly

Alexa+ for Builders is partner-gated. None of this has run against the real client, and
this document is not evidence that any of it would be accepted. It is the smallest
concrete thing we could offer instead of asking for "proactive support": a schema, a
working implementation behind it, and a demo where you can watch the beat happen and
read the frame it would have travelled on.
