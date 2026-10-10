# Friction log

Every entry below was hit while building Owed, not collected from reading. Each names the
task, what was expected, what actually happened, the severity, the workaround used, and
what would have prevented it.

Tools covered: MCP TypeScript SDK v2 (`@modelcontextprotocol/client|server|node|express`),
`@modelcontextprotocol/ext-apps`, `mcp-voice-simulator`'s conformance CLI, and the published
Alexa+ add-on documentation. `@modelcontextprotocol/core` is **not** covered: it is declared
as a dependency in three packages and imported in none, so there is nothing here we actually
learned about it.

This file is the friction log — the things that cost time, and what would have prevented
them. It is not the product feedback: for what each tool was used for, what worked well, how
onboarding felt and whether we would use it again, see
**[product-feedback.md](product-feedback.md)**.

Severity: **high** — blocked progress or would ship a broken add-on · **medium** — cost
significant time or forced a design change · **low** — papercut.

---

## 1. A zod `.transform()` in an `outputSchema` breaks `tools/list`, and only there

**Tool:** MCP TypeScript SDK v2 · **Severity: high**

**Task.** Give `ledger_summary` an `outputSchema` so `structuredContent` is validated and a
JSON Schema is advertised.

**Steps.** Our `Instant` schema validated an ISO-8601 string and then `.transform()`-ed it to
canonical UTC. That schema is nested inside the tool's `outputSchema`.

**Expected.** Either the transform is applied and the output schema is derived from the
output type, or registration fails loudly.

**Actual.** `tools/call` worked perfectly. `tools/list` failed at runtime with
`ProtocolError: Transforms cannot be represented in JSON Schema`. Because the failure only
appears when a client *lists* tools, unit tests over the handler passed and the tool looked
healthy. We found it only because a contract test drives a real client over real HTTP.

**Workaround.** Removed the transform and canonicalised instants in the constructors that
produce them instead, keeping the schema purely validating.

**Suggestion.** Reject a non-representable schema at `registerTool` time with a message
naming the offending field path. Failing at registration turns a confusing runtime protocol
error into an immediate, local one.

---

## 2. `npm install @modelcontextprotocol/ext-apps` does not give you the newest 2.x

**Tool:** `@modelcontextprotocol/ext-apps` · **Severity: medium**

**Task.** Pin the MCP Apps SDK.

**Expected.** `latest` points at the newest release of the current major.

**Actual.** `latest` = **2.0.0** while the `release-2.0` tag = **2.0.3**. A plain install
silently yields a version three patches behind, with no warning.

**Workaround.** Pinned `@modelcontextprotocol/ext-apps@2.0.3` explicitly.

**Suggestion.** Move `latest` to the newest stable release of the current major, or say so
prominently in the README. A dist-tag that does not mean "latest" is a trap that costs
people a debugging session against already-fixed bugs.

---

## 3. SDK v2 ships no authorization server, and the docs do not say what to do instead

**Tool:** MCP TypeScript SDK v2 · **Severity: medium-high**

**Task.** Implement OAuth 2.1 + PKCE account linking, which Alexa+ requires.

**Expected.** Some path to a working authorization server, as v1 offered via `mcpAuthRouter`
and `ProxyOAuthServerProvider`.

**Actual.** `@modelcontextprotocol/server` exports only resource-server helpers
(`requireBearerAuth`, `mcpAuthMetadataRouter`). The v1 authorization-server helpers are
frozen in `@modelcontextprotocol/server-legacy/auth`, and the guidance is "use a real IdP".
For a self-hosted add-on that must issue its own tokens — which is exactly what the Alexa+
add-on contract describes — there is no supported route. We wrote the authorization server
ourselves: metadata, authorize, consent, token, PKCE `S256`, refresh.

**Workaround.** A ~400-line authorization server using `jose`, in `packages/mcp-server/src/auth`.

**Suggestion.** Either keep a minimal reference authorization server in the SDK for
self-hosted servers, or publish a short "you now need an AS, here is a worked example"
migration note. Discovering this in week three of a four-week build would be fatal; we only
avoided it by checking the package's exports before planning.

---

## 4. The conformance probe sends no `Accept` header, which constrains middleware order

**Tool:** `mcp-voice-simulator` + Alexa+ docs · **Severity: medium**

**Task.** Pass `mcp-voice-simulator-conformance`.

**Expected.** The `unauthenticated-401` check would send a well-formed Streamable HTTP
request and expect a 401.

**Actual.** It posts with `content-type: application/json` and **no `Accept` header**. A
server that validates `Accept` before authenticating answers `406`, and the check — which is
an exact equality test on `401` — fails. Nothing in Amazon's documentation or the MCP spec
says authentication must precede transport validation.

**Workaround.** Mounted the bearer gate ahead of the MCP handler, and wrote a test that
sends the same header-less probe so the ordering cannot silently regress.

**Suggestion.** Document the required ordering, or have the checker send a spec-compliant
`Accept` header so it tests auth rather than middleware order.

---

## 5. Three sources disagree about `WWW-Authenticate` on 401

**Tool:** Alexa+ docs, RFC 9728, `mcp-voice-simulator` · **Severity: medium**

**Task.** Decide whether the 401 should carry a challenge header.

**Expected.** One answer: either the three sources agree, or Amazon's page is explicit
enough to settle it.

**Actual.** Amazon's account-linking page lists `WWW-Authenticate` under *not supported*.
RFC 9728 and general MCP convention say a 401 SHOULD carry one pointing at the
protected-resource metadata. The SDK's `requireBearerAuth` sends one by default. The
conformance checker prefers it absent while explicitly warning that the claim is secondhand
and should not justify removing a header that works.

**Workaround.** Made it a configuration flag defaulting to omitted (matching the Alexa+
target), with the conflict documented at the call site. Discovery works either way because
the well-known documents are always served.

**Suggestion.** Amazon: state plainly whether the header is *ignored* or *forbidden*. Those
are very different instructions, and the difference decides whether an add-on can also serve
generic MCP clients.

---

## 6. Amazon's docs disagree with themselves on the discovery path and the protocol version

**Tool:** Alexa+ add-on documentation · **Severity: medium**

**Task.** Serve the OAuth discovery documents where Alexa+ will look for them, and
declare a protocol version it will accept.

**Expected.** One well-known path per document and one protocol version, consistent across
Amazon's own pages.

**Actual.** The MCP QuickStart describes protected-resource metadata at
`/.well-known/oauth-authorization-server`, which is the RFC 8414 authorization-server path;
the account-linking page correctly uses `/.well-known/oauth-protected-resource`. Separately,
the overview states support for MCP `2025-11-25` while the client-lifecycle pages show an
`initialize` carrying `"protocolVersion": "2025-03-26"`.

**Workaround.** Served both documents at both path shapes, and left protocol-version
negotiation to the SDK rather than hard-failing on a mismatch.

**Suggestion.** A single normative table of well-known paths, and refreshed lifecycle
examples. A builder cannot tell which page is stale, so the only safe response is to
implement the union — which is more surface than anyone wants to maintain.

---

## 7. Alexa+'s elicitation support is one sentence

**Tool:** Alexa+ add-on documentation · **Severity: high for design confidence**

**Task.** Design the confirmation step before filing a claim — the product's central safety
guarantee is that no claim is filed without a human "yes".

**Expected.** A declared `elicitation` capability object with its modes, schema
restrictions, timeout and round limit — enough to know whether the product's central safety
guarantee can rest on it.

**Actual.** The documentation says only that "the system uses the existing elicitation
framework through the MCP protocol". It never states which elicitation modes Alexa+
declares, whether URL mode is supported, what the schema restrictions or timeouts are, or
how many rounds are allowed.

**Workaround.** Designed the tool to take an explicit `confirm` argument *and* elicit when
the client declares the capability, so the demo can never depend on elicitation working.
That is defensive duplication we would not have written with a documented contract.

**Suggestion.** Publish Alexa+'s declared `elicitation` capability object and its limits.
For any add-on that spends money or files something on a customer's behalf, this is the most
safety-critical part of the contract and currently the least specified.

---

## 8. `registerAppResource`'s argument order is easy to get wrong, and the examples hide it

**Tool:** `@modelcontextprotocol/ext-apps` · **Severity: low-medium**

**Task.** Register the three `ui://` views as app resources under names of our own
choosing.

**Expected.** An argument order that cannot be transposed silently, or examples in which a
transposition would show.

**Actual.** The signature is `registerAppResource(server, name, uri, config, readCallback)` —
**name before uri**. Every shipped example passes the same string for both, so the ordering
is invisible until a real name is used and the resource silently registers under the wrong
identifier.

**Workaround.** Read the type declaration rather than trusting the example.

**Suggestion.** Use distinct values in the examples, or take an options object.

---

## 9. `mcp-voice-simulator` cannot be embedded in a web app, which is not obvious from the package

**Tool:** `mcp-voice-simulator` · **Severity: medium**

**Task.** Embed the simulator inside our simulated-household UI.

**Expected.** A published `exports` map with types suggests library use in an app.

**Actual.** Three hard blocks, none documented in the README: the static server serves
exactly three paths, so a normal Vite build with hashed assets 404s; an origin guard rejects
any request whose `Host`/`Origin` is not its own port with 403, so a dev server on another
port cannot call it; and the page sets `x-frame-options: DENY`, so it cannot be iframed.

**Workaround.** Used its genuinely reusable parts — `McpSessionManager`, `linkAccount`,
`callTool` — inside our own Node process, and built our own MCP Apps host on
`@modelcontextprotocol/ext-apps/app-bridge`. This turned out better anyway: the MCP client
stays in Node where OAuth and SSE are debuggable, and the protocol inspector shows frames
captured at the transport rather than reconstructed.

**Suggestion.** State in the README that the server is a standalone app, not an embeddable
component, and point library users at the session/brain API directly.

---

## 10. The recommended stateless serving cannot elicit on the era Amazon documents

**Tool:** MCP TypeScript SDK v2 · **Severity: high**

**Task.** Ask the household to confirm before filing a claim — MCP elicitation, and a named
feature of our v1.

**Expected.** `inputRequired.elicit()` works wherever the tool runs. The SDK presents it as a
write-once idiom spanning both protocol eras via a legacy shim.

**Actual.** On a 2025-era connection served by `createMcpHandler` the question never reaches
anyone, and the result is an error:

> *Cannot request input 'confirm' (elicitation/create): the client on this 2025-era connection
> did not declare the required capability (no client capabilities are available on this
> connection — **per-request legacy serving cannot receive server-to-client requests**).*

2025-era elicitation is a server-to-client request and needs a session. `createMcpHandler`'s
`legacy` option accepts only `'stateless' | 'reject'` — there is no stateful setting — so on
the SDK's own recommended posture, elicitation is unavailable on the revision Amazon's Alexa+
documentation names. It works on 2026-07-28, where the request rides in the result and the
client retries.

**Credit where due:** that error message is the best in any SDK we used. It named the exact
constraint and saved what would otherwise have been hours.

**Workaround.** Elicit only where the connection can carry it — the 2026-07-28 era, or a
client that has declared the capability — and fall back to an explicit `confirm` argument
everywhere else. Both paths are tested.

**Suggestion.** Say this in the elicitation guide, next to the write-once idiom: the idiom is
write-once, but it is not *run-anywhere*. Better still, offer a sessionful option on
`createMcpHandler` so the two decisions are not coupled.

---

## 11. The documented elicitation example loops forever when the user declines

**Tool:** MCP TypeScript SDK v2 · **Severity: high**

**Task.** Handle "no" as well as "yes".

**Expected.** A declined elicitation distinguishable from one that was never asked, and a
worked example that handles both.

**Actual.** `acceptedContent()` returns `undefined` for a **declined** elicitation — exactly
as it does for one that was never asked. The worked example in the type documentation branches
on that single value:

```ts
const confirmed = acceptedContent(ctx.mcpReq.inputResponses, 'confirm');
if (!confirmed) { return inputRequired({ /* ask again */ }); }
```

Decline it and the server asks again, and again, until the client's driver gives up:
`Multi-round-trip request 'tools/call' still required input after 10 rounds`. We shipped that
exact shape and a test caught it.

`inputResponse()` is the right tool — it returns a discriminated view covering decline and
cancel — and its doc comment says so. But the example everybody will copy uses the other one.

**Workaround.** Read `inputResponse(responses, key)` and branch on `action`.

**Suggestion.** Fix the worked example to handle decline, or make `acceptedContent` harder to
misuse. A user saying "no" being read as "not asked yet" is the single most predictable way
this API gets used wrongly.

---

## 12. A view's CSP lands on the listing, not on the thing a host reads

**Tool:** `@modelcontextprotocol/ext-apps` · **Severity: medium**

**Task.** Declare a deny-by-default content security policy for each `ui://` view.

**Expected.** A policy declared once at registration and in force wherever a host reads the
view — including the read that rendering requires.

**Actual.** `registerAppResource(server, name, uri, { _meta: { ui: { csp } } }, read)` puts the
policy on the `resources/list` entry. A host that reads the resource — which is what it must do
to render it — receives content items with no `_meta` at all. Our own contract test failed on
exactly this, and we had believed the policy was in force for weeks.

The docs do say the listing value is a "fallback" and the content item takes precedence. They
do not say that supplying only the config value means most hosts never see one.

**Workaround.** Repeat `_meta.ui` on every content item returned by the read callback.

**Suggestion.** Have `registerAppResource` copy the config's `_meta.ui` onto returned content
items unless the callback sets its own. The current split is a trap with a silent failure mode.

---

## 13. Express handler parameters lose their types through `createMcpExpressApp()`

**Tool:** `@modelcontextprotocol/express` · **Severity: low**

**Task.** Mount the MCP route on the app `createMcpExpressApp()` returns, under `strict`.

**Expected.** Handler parameters typed from the returned `Express` instance, the way they
are on an app from `express()`.

**Actual.** `createMcpExpressApp()` returns `Express`, and `@types/express` resolves
correctly, but `app.all("/mcp", (req, res) => …)` still produces `TS7006: implicitly has an
'any' type` under `strict`. Annotating the parameters explicitly fixes it.

**Workaround.** `(req: Request, res: Response)` at every call site.

**Suggestion.** Worth a line in the Express serving guide; every strict-mode TypeScript user
will hit it in their first five minutes.

---

## 14. The published docs describe no way for an add-on to speak first

**Surface:** Alexa+ add-on model · **Severity: high** — this one is a feature request, not a bug.

**Task.** Tell the household a parcel never arrived.

**Expected.** Some channel — a scheduled wake, an event push, anything — that reaches a
device without a person having started the exchange.

**Actual.** The published documentation describes nothing of the kind, and we could not
find one. Everything documented is reactive: a tool runs because somebody said something.
No scheduled wake, no event channel, no documented way to reach a device unless a person
started the exchange.

For most add-ons that would be a limitation. For this one it looked like it removed the
product. Owed exists to notice what the household did *not* ask about, and the moment that
only works if somebody thinks to ask is the moment it is worth nothing — people do not wake
up wondering whether a courier honoured a delivery guarantee eleven days ago. That is
exactly the work they wanted handed off.

**Correction, and the reason this entry is now about documentation.** We first wrote this up
as a platform limitation — "an add-on cannot say anything first". On review we were told the
public documentation is incomplete here and that a good deal is omitted. We have not verified
either way, and the honest position is the narrow one: *we checked the docs, not the
platform.* So this is a documentation gap with a product-shaped consequence, which is worth
more as feedback than a complaint about a capability that may well exist.

**Workaround.** The server derives everything Owed would say unprompted as a projection
of the ledger and serves it outside the MCP surface; the simulated home's host polls it
and badges every announcement `simulated proactive`. Honest, and not shippable.

**Suggestion.** Publish the contract. If a proactive path exists, the single highest-value
documentation change for this class of add-on is to say so and specify it — because a builder
who cannot find it designs around its absence, which is exactly what we did. And whatever the
shape turns out to be, we have written the one we would need as a schema rather than asking
for "proactive support" in the abstract — `CommitmentEvent`, with the three fields we think
are easy to leave out and expensive to add later:

- `expires_at`, because proactive speech has to be allowed to go stale. Being told on
  Friday about a parcel that failed on Sunday is worse than silence.
- `urgency`, because only the add-on knows whether money is about to stop being
  recoverable, and only the host knows whether now is a reasonable moment to interrupt.
  Neither can decide alone.
- `offer`, the utterance and tool the household can respond with. Without it an
  announcement is a dead end: somebody hears that something is wrong and has to work out
  for themselves how to ask for it to be fixed.

The schema, the rules a scheduler should keep, and a working implementation behind all of
it: **docs/proactive.md**.
