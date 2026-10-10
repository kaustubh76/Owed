# Product feedback

Submission requirement (d): *product feedback on every tool, API, or SDK used — what it was
used for, what worked well, what needs work, how onboarding felt, and whether we would build
with it again.* The AWS section is part of this answer rather than a separate document,
because the rules ask for it here.

Two ground rules, so this is worth reading:

**Only tools this repository actually calls appear below.** Every entry is backed by an
import site or an invoked binary. `@modelcontextprotocol/core` is declared as a dependency in
three packages and imported in none, so it is absent — we learned nothing about it and have
nothing to say. The Ring Partner API, `better-sqlite3` and Docker-as-a-runtime appear in
earlier design notes and in none of the code; they are absent for the same reason.

**Where something did not run, this says so.** Amazon Bedrock is the important case: the
integration is written and tested either side of the model call, and the model call itself has
never executed. That is stated in its own section rather than buried.

The sharper, reproduction-shaped version of the defects below is
**[friction-log.md](friction-log.md)** — fourteen entries, each with the task, what was
expected, what happened, severity, the workaround, and what would have prevented it. This
document is the wider judgement: what each tool was *for*, and whether we would choose it
again.

---

## AWS

### Amazon DynamoDB

**Used it for** the household ledger — the append-only event log that every number in the
product is derived from. It is one of three adapters behind a two-method `EventStore` port
(`append`, `read`); the others are in-memory and `node:sqlite`. Partition key `household_id`,
sort key `seq` as a zero-padded string, appends through `TransactWriteCommand` with
`ConditionExpression: attribute_not_exists(sk)`, and the sequence number from a separate
`UpdateCommand` using `ADD`. Verified against the real service in `us-east-1`: 81 events plus
the counter item, the seeded week byte-comparable against the in-memory adapter, and the
Alexa+ conformance checker green against the DynamoDB-backed server.

**What worked well.** The conditional write is exactly the right primitive for an
append-only log. `attribute_not_exists(sk)` turns "two writers raced for sequence number 42"
into a failed transaction rather than a silently overwritten event, and it needs no lock, no
version column and no read-before-write. An event-sourced ledger is a very good fit for this
database, and `TransactWriteItems` plus a conditional expression expresses the whole
guarantee in one request. `@aws-sdk/lib-dynamodb` meant we never hand-wrote an attribute-value
map.

**What needs work.**

*The sort key cannot be time if ordering must be stable.* Our first schema sorted by
timestamp, which is the natural choice and reads beautifully — until two events share a
millisecond and the adapter returns them in a different order from the other two adapters, so
a replay produces a different ledger depending on which store is behind the port. The fix was
to sort by sequence number and demote time to a `FilterExpression`, which costs read-capacity
on events that are then discarded. A single-table design note about "monotonic ordering under
equal timestamps" would have saved the rewrite — this is a general event-sourcing problem,
not a quirk of ours.

*The default retry posture is wrong for an interactive path.* The SDK's defaults are tuned
for throughput, and a tool call that a person is waiting on wants to fail fast and say so. We
settled on `maxAttempts: 3` with a 3 s request timeout and 1.5 s connection timeout. Those
are not hard numbers to find, but nothing in the getting-started path suggests that a
user-facing caller should set them at all.

**Onboarding.** Good, with one sharp edge that cost real time and belongs to IAM rather than
to DynamoDB — see below.

**Would we build with it again.** Yes, without hesitation, for this shape of problem. An
append-only log with a conditional write on a composite key is one of the things this database
is unambiguously best at.

### IAM — one finding worth the whole section

**`dynamodb:TransactWriteItems` is not an IAM action, and the console rejects it outright.**

The SDK command is `TransactWriteCommand`, the wire operation is `TransactWriteItems`, and
the obvious policy is therefore wrong. DynamoDB's transactional APIs have no IAM action of
their own: permission is derived from the component operations, so a `Put` inside a
`TransactWriteItems` is authorised by `dynamodb:PutItem`. We found this the direct way — the
policy editor refused to save the string.

**What needs work.** The error names the action as nonexistent but does not say what to use
instead, and the DynamoDB IAM page lists the supported actions without remarking that the
transactional operations are deliberately missing from it. One sentence — "transactional
operations are authorised by their component actions; there is no `TransactWriteItems`
permission" — on either the IAM reference or the transactions page would close this
permanently. As it stands, the most natural guess produces an error that reads like a typo,
and the next guess is usually to widen the policy to `dynamodb:*`, which is the opposite of
what anyone wants.

**Would we use it again.** Yes. The resulting policy is eight actions scoped to one table ARN
and nothing else, which is what least privilege should look like. Getting there was harder
than it needed to be.

### AWS SDK for JavaScript v3 — `@aws-sdk/client-dynamodb`, `@aws-sdk/lib-dynamodb`

**Used it for** every ledger operation, plus first-run table creation (`CreateTableCommand`,
then `DescribeTableCommand` to wait) so a fresh deployment needs no manual setup.

**What worked well.** Modular clients keep the dependency honest — the server pulls two
packages, not an SDK. `lib-dynamodb`'s document client is the right abstraction and we never
once wanted the raw form. Typed command inputs caught two schema mistakes at compile time.
`ThrottlingException` being an exported class, rather than a string to compare against, makes
"retry only this" a type-checked condition instead of a guess.

**What needs work.** The nesting of `requestHandler.requestTimeout` and
`connectionTimeout` alongside the top-level `maxAttempts` is not discoverable; we found the
shape by reading types, not docs. And the boundary between `client-dynamodb` and
`lib-dynamodb` is unexplained at install time — you need both, and which commands come from
which is something you learn by failing to import one.

**Onboarding.** Smooth. Credentials resolved from the environment with no configuration, and
the first successful write happened within minutes of the policy being right.

**Would we build with it again.** Yes.

### `aws` CLI v2

**Used it for** creating and deleting the ledger table, waiting on table state, scanning it to
confirm what the server had written, and `sts get-caller-identity` in `scripts/aws-smoke.mjs`
to assert the smoke test is pointed at the intended account before it writes anything.

**What worked well.** `aws dynamodb wait table-exists` removes a polling loop from our
scripts entirely. `get-caller-identity` is the right primitive for a guard — cheap,
unambiguous, and needs no permission to call.

**What needs work.** `create-table` with a composite key is a long command whose
`--attribute-definitions` and `--key-schema` must agree, and a mismatch surfaces as a
validation error naming neither flag. Worth an example in `help` output rather than only on
the web.

**Would we use it again.** Yes.

### Amazon Linux 2023 (arm64) — `deploy/bootstrap.sh`

**Used it for** the deployment target: one `t4g.small`, Caddy in front, three Node services on
loopback. The script installs checksum-verified Node and Caddy, builds, writes
`/etc/owed/owed.env`, and enables three systemd units. The install half was proven by running
it in an `amazonlinux:2023` container until it exited 0.

**What worked well.** `dnf` is fast, the arm64 images are current, and the base image is
genuinely minimal — which is a virtue, and also the source of everything below.

**What needs work — all four found by executing the script, not by reading it.**

1. **The base image lacks `xz`, `openssl` and `libatomic`.** Node's official tarball is
   `.tar.xz` and its binary links `libatomic` on arm64, so an install that looks like it
   should work fails at extraction and then at first execution. None of these appear in Node's
   own Linux prerequisites.
2. **Node 26 no longer ships `corepack`**, so `corepack enable pnpm` — the documented way to
   get pnpm, and what our script did — fails on a current Node. `npm install -g pnpm@<version>`
   works. This is a reasonable removal, but it silently breaks every bootstrap script written
   against Node 20–22.
3. **Caddy publishes SHA-512 digests where Node publishes SHA-256**, and `sha256sum -c` given
   a SHA-512 line prints a warning and **exits 0**. Our script therefore installed Caddy
   *unverified* while printing a line that said it had been checked — the worst possible
   outcome, and invisible without reading the output character by character. We now select the
   checker by digest length. A warning that does not fail is a trap, and this one is in the
   middle of a supply-chain check.
4. **`systemd-analyze verify` exits 0 on a misplaced directive.** `StartLimitIntervalSec` in
   `[Service]` is read from `[Unit]`; ours was in the wrong section and silently did nothing,
   and the verifier warned and passed. Same failure shape as (3): the tool told the truth in a
   stream nobody reads and reported success.

**Onboarding.** Fine. The friction was not Amazon Linux's — it was in three other tools'
assumptions about what a Linux image contains, which a minimal image exposes.

**Would we build with it again.** Yes, and we would again prove the script by running it in
the matching container before touching a real instance. That one habit found all four.

### Amazon Bedrock — written, tested, and never run

**Used it for** `@owed/extractor-bedrock`: an adapter behind the same extractor port as the
deterministic rule-based one, pulling delivery promises out of merchant message text. It calls
the **Converse** API (`@aws-sdk/client-bedrock-runtime`), defaults to
`amazon.nova-2-lite-v1:0`, is model-agnostic by design because everything goes through
Converse, and retries `ThrottlingException` only — every other failure, including no model
access, a bad model id and malformed credentials, fails identically on every attempt, so
retrying it only delays the error.

**This has never executed against the service.** We do not have model access on this account.
The prompt construction and the response parsing are unit-tested, the retry predicate is
tested, and the boundary — the `ConverseCommand` itself — is not. We are not claiming a
working Bedrock integration, and the README's real-vs-simulated map says the same.

**Feedback we can honestly give, which is about getting to the API rather than using it.** The
Converse API is the right abstraction: one request shape across model families means the
adapter has no vendor branches and a model swap is an environment variable. Having
`ThrottlingException` exported as a class made "retry this and nothing else" a type-checked
decision. What needs work is that **model access is a prerequisite with a wait, and nothing
in the SDK or the quickstart says so early enough**: the code compiles, the client constructs,
credentials resolve, and the first thing that tells you access was never granted is a runtime
error on the first call. A check in the console's getting-started path — or a clearer named
error distinguishing "not enabled for this account" from "model not found" — would have moved
this discovery to the beginning of the work instead of the end.

**Would we build with it again.** The design, yes, and we would keep the port so the
deterministic extractor stays the default. Next time we would request model access on day one,
because it is the only dependency here with a human in the loop.

---

## MCP

### `@modelcontextprotocol/server` 2.1.0

**Used it for** the product itself. Owed is an MCP server, not an application with an MCP
wrapper: six tools — `ledger_summary`, `promises_list`, `promise_check`, `claim_status`,
`evidence_get` and `claim_file` — with `_meta.ui` on every one, elicitation before anything
irreversible, and three `ui://` view resources (`ledger`, `claim`, `evidence`). Thirteen
import sites. The declared protocol version is `2025-11-25`.

**What worked well.** The `McpServer` class is a small, honest object: construct it, register
things on it, and all shared state stays outside it — which is what let us create a fresh
server per request without a second thought. `structuredContent` validated against
`outputSchema` caught real bugs during development. Protocol version negotiation handled a
client advertising an older version without any code from us, which mattered because Amazon's
own documentation is inconsistent about which version Alexa+ sends.

`registerTool` with a zod `inputSchema` and `outputSchema` is good: one declaration produces
runtime validation of both directions, the advertised JSON Schema, and the handler's types.
We use it for the merchant agents' single `recourse_respond` tool, which has no UI. **We can
compare it directly against `registerAppTool` from `ext-apps/server`**, which the six Owed
tools use because each carries a `_meta.ui` view — and the comparison is the useful feedback:
the two are the same API with one field added, which is exactly right. Moving a tool between
them is a one-line change, and nothing about the view binding leaks into the base API. That
layering is worth preserving.

This package also supplies the elicitation primitives (`inputRequired`, `inputResponse`) and
the JSON Schema generation — and that last one is where the first defect below lives,
regardless of which register function was called.

**What needs work.**

*A zod `.transform()` anywhere inside an `outputSchema` breaks `tools/list` and only
`tools/list`* — wherever the tool was registered, since the JSON Schema conversion is this
package's. `tools/call` works perfectly; listing throws `Transforms cannot be represented
in JSON Schema` at runtime. Because the failure needs a client to *list* tools, unit tests
over the handler pass and the tool looks healthy. Rejecting a non-representable schema at
`registerTool` time, naming the offending field path, would convert a confusing runtime
protocol error into an immediate local one.

*`acceptedContent()` returns `undefined` for a declined elicitation and `undefined` for one
never asked.* The worked example in the type documentation branches on that single value and
therefore re-asks forever when the user says no — until the client's driver gives up after ten
rounds. We shipped that exact shape and a test caught it. `inputResponse()` is the correct
tool and its doc comment says so, but the example everyone will copy uses the other one. A
person saying "no" being read as "not asked yet" is the most predictable way this API gets
used wrongly, and for an add-on that files claims on someone's behalf it is a safety bug.

**Onboarding.** Good for the tool surface, and there is a real hole next to it: **v2 ships no
authorization server**, and the docs do not say so plainly. Alexa+ requires OAuth 2.1 and does
not support Dynamic Client Registration, so we implemented the authorization server —
PKCE S256, RFC 9728 and RFC 8414 discovery documents, resource indicators — ourselves. That is
a legitimate scope decision, but discovering it took a while, and it is the single largest
piece of work between `registerTool` working and an add-on Alexa+ will accept.

**Would we build with it again.** Yes. The tool and resource APIs are good enough that we
would start here again knowing the auth work is ours.

### `@modelcontextprotocol/client` 2.1.0

**Used it for** two things. Driving the contract tests — a real client, over real HTTP,
against a booted server — and the server's own outbound calls to the merchant agents, which
are themselves MCP servers (`merchants/http.ts`). Owed is a client as well as a server.

**What worked well.** It found the `tools/list` defect above, which no handler-level test
could have. Being able to use the same client in tests and in production code meant the
merchant transport needed no second implementation.

**What needs work.** Nothing we hit.

**Would we build with it again.** Yes — and we would again write at least one test that drives
the server the way a host does. That decision caught two of the four worst bugs in this
project.

### `@modelcontextprotocol/node` 2.1.0 and `@modelcontextprotocol/express` 2.0.1

**Used it for** Streamable HTTP transport and mounting the MCP route into the Express app that
also serves the OAuth endpoints and discovery documents.

**What worked well.** `createMcpExpressApp()` gets a working transport up in a few lines, and
sharing one Express app between the MCP route and the OAuth endpoints meant one origin, one
TLS certificate and one process.

**What needs work.**

*Handler parameters lose their types.* `createMcpExpressApp()` returns `Express` and
`@types/express` resolves correctly, yet `app.all("/mcp", (req, res) => …)` still produces
`TS7006: implicitly has an 'any' type` under `strict`. Explicit `(req: Request, res: Response)`
annotations fix it. Every strict-mode TypeScript user hits this in their first five minutes
and it deserves a line in the serving guide.

*The recommended stateless serving mode cannot elicit.* Elicitation needs the session that
stateless serving does not keep, and the serving guide recommends stateless without noting
what it costs. For an add-on whose central safety property is a human confirmation, that is
not a minor footnote — it decides the architecture.

**Would we build with it again.** Yes.

### `@modelcontextprotocol/ext-apps` 2.0.3

**Used it for** the visual surface: three `ui://` view resources served by the MCP server, and
the host-side bridge in the simulated home. Nine import sites across three subpaths —
`/server`, `/react` and `/app-bridge`.

**What worked well.** The three-way split is the right factoring: the server package has no
React, the view package has no transport, and the bridge is small. Views being resources
rather than a bespoke channel means they are versioned, cacheable and inspectable with the
same tools as everything else.

**`registerAppTool` is the best tool-declaration API we have used.** One call declares the
name, title, description, a zod `inputSchema`, a zod `outputSchema`, the `annotations` hints
and the `_meta.ui` binding to a view — and from that single declaration you get runtime
validation of both directions, the advertised JSON Schema, and the handler's TypeScript types,
with the argument object destructured and typed. All six Owed tools are declared this way.

Co-locating the view binding with the tool is the specific thing that works: the
`resourceUri`, the `invoking` string and the `invoked` string sit next to the handler that
produces the data, so a tool and its card cannot drift apart. We wrote no glue between them
at all. And because it is `registerTool` plus one field, a tool that loses its card loses one
line rather than changing packages.

**What needs work.**

*A view's CSP lands on the listing, not on the thing a host reads.* Passing
`{ _meta: { ui: { csp } } }` to `registerAppResource` puts the policy on the `resources/list`
entry; a host that *reads* the resource — which it must, to render it — receives content items
with no `_meta` at all. Our own contract test failed on this after we had believed the policy
was in force for weeks. The docs do say the listing value is a "fallback" and the content item
takes precedence; they do not say that supplying only the config value means most hosts never
see one. `registerAppResource` should copy the config's `_meta.ui` onto returned content items
unless the callback sets its own. This is a trap with a silent failure mode, and the thing
failing silently is a security policy.

*`registerAppResource(server, name, uri, config, read)` takes name before uri*, and every
shipped example passes the same string for both, so a transposition is invisible until a real
name is used and the resource registers under the wrong identifier. Distinct values in the
examples would fix it; an options object would fix it permanently.

*`npm install @modelcontextprotocol/ext-apps` does not give you the newest 2.x.* We are on
2.0.3 while the rest of the SDK is 2.1.0, which is itself a question nobody can answer from
the registry.

**Onboarding.** The hardest of the MCP packages, for a structural reason: it is the one where
the server, the view and the host each hold part of the contract, and the documentation is
organised per package rather than per contract.

**Would we build with it again.** Yes. The model is right and these are fixable defects.

### `mcp-voice-simulator` 0.2.2 — the conformance CLI

**Used it for** an external check on the Alexa+ contract, run by `pnpm verify` and in CI
against a freshly booted server. We did not want our only evidence of conformance to be our
own tests.

**What worked well.** Enormously valuable simply by being somebody else's opinion. Four
assertions about OAuth discovery, and the fact that we did not write them is the point.

**What needs work.**

*The probe sends no `Accept` header*, which a spec-compliant Streamable HTTP server is
entitled to reject — so a correct server can fail the check.

*It cannot be embedded in a web application*, which is not apparent from the package: it is a
CLI with a terminal UI, not a library. We added it as a dependency intending to drive the
simulated home with it and had to back that out. A line in the README would have saved the
attempt.

*It is honest in a way worth praising.* On `WWW-Authenticate` it prefers the header absent
while explicitly warning that the claim is secondhand and should not justify removing a header
that works. More tools should say when they are unsure.

**Would we use it again.** Yes, and earlier. It is the only external arbiter available for a
contract we cannot otherwise test, because the real client is partner-gated.

### Alexa+ add-on documentation

Not an SDK, but the interface we built against, and the requirement asks about APIs.

**Used it for** everything about the contract we could not learn from the MCP spec: account
linking, which OAuth features are supported, discovery paths, and the add-on lifecycle.

**What worked well.** The account-linking page is specific about what is *not* supported — no
Dynamic Client Registration — and that kind of negative statement is more useful than a
feature list. It let us build the authorization server correctly the first time.

**What needs work.**

*The docs disagree with themselves on both the discovery path and the protocol version.* The
MCP QuickStart puts protected-resource metadata at `/.well-known/oauth-authorization-server`,
which is the RFC 8414 authorization-server path; the account-linking page correctly uses
`/.well-known/oauth-protected-resource`. Separately the overview states support for MCP
`2025-11-25` while the client-lifecycle pages show an `initialize` carrying
`"protocolVersion": "2025-03-26"`. A builder cannot tell which page is stale, so the only safe
response is to implement the union — more surface than anyone wants to maintain. One normative
table of well-known paths would fix it.

*Elicitation support is one sentence.* "The system uses the existing elicitation framework
through the MCP protocol" does not say which modes Alexa+ declares, whether URL mode is
supported, what the schema restrictions or timeouts are, or how many rounds are allowed. We
therefore designed the tool to take an explicit `confirm` argument *and* elicit when the
client declares the capability, so the demo can never depend on elicitation working — defensive
duplication we would not have written against a documented contract. For any add-on that
spends money or files something on a customer's behalf, this is the most safety-critical part
of the contract and currently the least specified. Publishing Alexa+'s declared `elicitation`
capability object and its limits would be the single highest-value documentation change for
this class of add-on.

*`WWW-Authenticate` is listed under "not supported" without saying whether it is ignored or
forbidden.* Those are different instructions, and the difference decides whether one server
can serve both Alexa+ and generic MCP clients.

*Nothing documented lets an add-on say anything first.* Everything in the published docs is
reactive: no scheduled wake, no event channel, no documented way to reach a device unless a
person started the exchange. For most add-ons that would be an inconvenience; for this one it
looked like it removed the product, because Owed exists to notice what the household did *not*
ask about.

We first reported that as a platform limitation. On review we were told the public
documentation is incomplete here and that a good deal is omitted — so the capability may exist
and we simply could not find it. We have not verified either way, and the claim we can stand
behind is the narrow one: **we checked the docs, not the platform.** Which makes this the
highest-value documentation request on this page, because a builder who cannot find a
capability designs around its absence, and we did: the whole proactive surface in this project
is a simulation with a `simulated proactive` badge on it.

The shape we designed for is written as a schema rather than a request for "proactive support"
in the abstract — `CommitmentEvent`, with `expires_at`, `urgency` and `offer`, in
**[proactive.md](proactive.md)**.

**Would we build against it again.** Yes. The contract is implementable and the hard parts
are documentation, not design.

---

## Everything else we actually used

Grouped because the feedback is shorter, not because the usage was marginal. All of these
have import sites or are invoked by `pnpm verify`.

| Tool | Used it for | Worked well / needs work | Again |
|---|---|---|---|
| **zod 4** | Every schema in the project — domain types, tool inputs and outputs, policy definitions. Declared in ten packages. | The one dependency we would call load-bearing. `.transform()` interacting badly with JSON Schema generation (above) is an MCP-side problem, but it is the only time zod surprised us. | Yes |
| **Node 26** | Runtime for all three services. `node:sqlite` is the second `EventStore` adapter, so persistence needs no native module and no dependency. | `node:sqlite` is a genuinely significant addition — an append-only store that survives restart, with nothing in `package.json`. Needs work: `corepack` removal breaks existing bootstrap scripts silently (above), and `fetch` silently drops a forbidden `Host` header, which made one of our security tests pass vacuously until we rewrote it on `node:http`. | Yes |
| **TypeScript 7** | Project references across every workspace member, `strict` everywhere. | Build-mode references keep the package graph honest — a missing dependency is a compile error, which is how we know the port boundaries hold. Needs work: `tsc -b` and Vite both defaulting to `dist` let two tools fight over one directory, which replaced our deployed site with ES modules and no `index.html`. Not TypeScript's fault, but a louder default would have helped. | Yes |
| **Vitest 5** | The whole suite: unit, property, contract-over-HTTP, and a storyboard golden test. | Fast, and the worker-per-file default is correct until the host is under load. Needs work: no built-in way to cap workers relative to machine state; we pinned `maxWorkers` by hand after a run drove the load average into the hundreds. | Yes |
| **fast-check 4** | Property tests over ledger replay and the coverage engine. | Shrinking found an ordering bug a hand-written case would not have. Nothing to criticise. | Yes |
| **Express 5** | The HTTP surface the MCP transport, OAuth endpoints and discovery documents share. | Stable and unremarkable, which is the compliment. Needs work: async error handling still requires an explicit error middleware to avoid an unhandled rejection taking the process down — we lost a running server to exactly that. | Yes |
| **`jose` 6** | HS256 token signing and verification for the authorization server; the household identity is the token's `sub`. | Correct, modern, no surprises, and the API makes the safe thing the easy thing. | Yes |
| **React 19 + Vite 8** | The simulated home, and the three `ui://` views built as single files via `vite-plugin-singlefile`. | Single-file output is exactly right for a view that must be one resource. Needs work: `VITE_*` variables are inlined at build time, so a site built without `VITE_BRAIN_URL` told every visitor to connect to their own localhost — a build-time/deploy-time mismatch with no runtime warning. | Yes |
| **Playwright** | `pnpm verify:ui` drives the whole storyboard in a real browser, including the voice-only Echo Dot path. | The only way to assert that a spoken line still makes sense when the card is removed. Needs work: `channel: "chrome"` requires a Chrome install that is not a declared prerequisite anywhere — including, until now, in our own README. | Yes |
| **Biome 2** | Lint and format, one tool, in `pnpm verify`. | Fast enough to be unnoticeable and replaced two tools. No complaints. | Yes |
| **pnpm** | The workspace — nine packages, two apps and the eval harness, linked with `workspace:*`. | Strict resolution is why the `@modelcontextprotocol/client` misplacement described in our own notes was findable at all — a flat installer would have hidden it. Needs work: nothing. | Yes |
| **Caddy 2** | TLS and the entire public surface of the deployment. | Automatic certificates and a config file short enough to review in one screen. Needs work, and this one was expensive: `health_uri` sends `Host: <upstream-address>`, which our DNS-rebinding protection answers with 403, so Caddy pulled the only upstream and served a bare 503 for all MCP traffic — a healthy server taken off the air by its own monitoring. The health checker should send the configured upstream hostname, or document that it does not. | Yes |
| **systemd** | Three units, one process each, so a crash is visible and restartable. | Restart policy and resource limits for free. Needs work: `systemd-analyze verify` exiting 0 on a directive in the wrong section (above). A verifier that warns and passes is a verifier you stop reading. | Yes |
| **GitHub Actions** | `pnpm verify` plus the conformance check on every push, with DynamoDB Local as a service container. | Service containers made the ledger adapter testable in CI, which it previously was not. Needs work: a service with no usable `--health-cmd` — DynamoDB Local answers HTTP 400 to a bare `GET` — forces the polling into the test file, where it is easy to turn into a silent skip. We set `OWED_REQUIRE_DYNAMO` to make that skip impossible. | Yes |

---

## The one thing we would tell the Alexa+ team first

Three of the four things that cost us the most time share a shape: **a tool reported success
while the thing it checked had not happened.** `sha256sum -c` warned about a SHA-512 line and
exited 0, so a supply-chain check passed without checking. `systemd-analyze verify` warned
about a misplaced directive and exited 0. A `/health` route with no explicit handler fell
through to the static site and returned `index.html` with a 200, so a monitor would have
reported healthy forever regardless of the database. And in the SDK, `acceptedContent()`
returns the same `undefined` for "the user declined" as for "we never asked".

None of these are hard to fix once seen. All of them are invisible to anyone who trusts an
exit code, which is everyone, in CI, by design. If there is one thing worth carrying back from
this build: **the failure mode that survives a test suite is the one where the check itself
cannot fail.**
