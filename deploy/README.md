# deploy/

One box, Caddy in front, three Node services on loopback. Nothing here is needed to run or
judge the demo — `pnpm demo` is unchanged and still needs no account and no keys.

| File | |
|---|---|
| `Caddyfile` | The entire public surface. Validated against real Caddy, and every route the server registers is resolved against the config `caddy adapt` compiles. Deliberately does **not** proxy `/control/*` or `/health`; deliberately **does** proxy `/docs/*`, which the OAuth metadata advertises by absolute URL. |
| `caddy.service` | Shipped because Caddy installs as a static binary here, so there is no packaged unit. |
| `owed-server.service`, `owed-brain.service`, `owed-merchants.service` | One process each, so a crash is visible and restartable rather than one shell holding three. |
| `bootstrap.sh` | Amazon Linux 2023 arm64, run once as root. Installs checksum-verified Node and Caddy, builds, writes `/etc/owed/owed.env`, enables the units. |
| `iam-policy-phase1.json` | Least privilege for the Phase 1 smoke test: the ledger table and nothing else. |
| `iam-policy-bedrock.json` | `bedrock:InvokeModel` on one model, for `packages/extractor-bedrock`. **Not attached to anything** — see below. |
| `create-cli-user.sh` | Creates that policy, a user, and an access key — **run it in AWS CloudShell**, which is already authenticated as the console user and so needs no key to create one. Self-contained, because CloudShell has no checkout; its inline policy is the same statement as the JSON above, except that it substitutes the account it discovers via `sts:GetCallerIdentity` where the file carries an `AWS_ACCOUNT_ID` placeholder. Change one, change both. |

## Checking this directory without a Linux box

`pnpm verify:deploy` runs 35 structural checks on the four units and the Caddyfile on any
machine, and fifteen more that resolve every route the server registers against the config
`caddy adapt` compiles — those need caddy, natively or in a container. The three real validators need Linux — `systemd-analyze` cannot meaningfully exist on
macOS — so on a Mac they report as skipped and only CI ever ran them, which left this
directory the one place edited locally and checked remotely.

```bash
OWED_DOCKER_VALIDATORS=1 pnpm verify:deploy
```

That runs `shellcheck --severity=warning` on both scripts, `systemd-analyze verify` on all four
units, and `caddy validate` on the Caddyfile, each in a Linux container, and says which ran in
a container rather than natively. Measured on systemd 257: clean, exit 0, no findings — once
`node`, `caddy` and the `owed` user exist in the container, which the gate stubs, because a
unit whose `ExecStart` interpreter is missing is reported and in a bare container every one of
them is.

Off by default: it pulls a few hundred megabytes of images and the systemd route installs a
package inside the container, so `pnpm verify` behaves exactly as it did.

## Three things that will look like bugs and are not

**`iam-policy-bedrock.json` exists and is attached to nothing.** That is the point of it.
`packages/extractor-bedrock` sends `ConverseCommand`, which needs exactly one action —
`bedrock:InvokeModel`, on the model's ARN — and readme §15 says the Phase 1 user grants no
Bedrock action by design, that no model has been invoked from this account, and that nothing
in the repository claims a Bedrock result. All three remain true. What changed is that the
permission a reader would have to reconstruct is now written down, minimal and reviewable, so
the remaining gap is a decision and a call nobody has made rather than a missing artifact.

Two details in it are deliberate. There is no `bedrock:InvokeModelWithResponseStream`, because
the adapter does not stream, and granting an action nothing sends is how a least-privilege
policy stops being one. And there are two resource ARNs for one model: a foundation model's
ARN carries an **empty account field**, while invoking the same model through a cross-region
inference profile needs an account-qualified `inference-profile/us.…` ARN. Granting only the
first is the mistake that produces an `AccessDeniedException` naming a model you can plainly
see you have access to.

`pnpm verify:deploy` checks all of this: that the policy grants exactly the action the adapter
sends, that it names the model `DEFAULT_MODEL_ID` actually defaults to, and that
`create-cli-user.sh` hands out no Bedrock permission — which turns §15's claim from an
assertion into a check.

## Two more things that will look like bugs and are not

**`dynamodb:TransactWriteItems` is absent from the IAM policy on purpose.** DynamoDB's
transactional APIs have **no IAM action of their own** — the IAM console rejects that string
outright. Permission is derived from the component operations, so a `Put` inside a
`TransactWriteItems` needs `dynamodb:PutItem`, which is in the list. The SDK command is
called `TransactWriteCommand`, so a matching permission is the natural thing to expect; it
does not exist. (Found the direct way: the console refused it.)

**The services keep listening on `127.0.0.1` even when deployed.** Caddy runs on the same
box and proxies to loopback, so nothing needs a public interface. The security group opens
only 80, 443, and 22 from one address. That is also why `/control/*` — which carries no auth
of its own and would otherwise leak the merchant negotiations verbatim — needs no public
route at all.

**That is now a check and not a comment.** The Caddyfile's deny blocks were the only thing
standing between those endpoints and the internet, and nothing asserted them: deleting both
was an edit all nine gates passed. `pnpm verify:deploy` resolves each registered route
against the compiled config and requires it to be deliberately proxied or deliberately
refused, so publishing one is now an edit to a table of reasons rather than a deletion
nobody notices.

## `pnpm verify:ui` needs a fresh ledger

Against the in-memory store this is automatic — every boot reseeds, so every run starts
from the same seeded week. Against a persistent ledger it is not: the storyboard **files a
claim**, and a second run finds that claim already filed, takes `claim_file`'s idempotent
path, and the claim card never changes. The run fails on a check that is reporting correct
behaviour.

So when pointing it at DynamoDB, start from an empty table:

```bash
aws dynamodb delete-table --table-name owed-ledger --region us-east-1
aws dynamodb wait table-not-exists --table-name owed-ledger --region us-east-1
# recreate, then
OWED_DYNAMO_TABLE=owed-ledger AWS_REGION=us-east-1 pnpm verify:ui
```

`pnpm aws:smoke` has no such requirement — it asserts the seeded week is a *prefix* of the
table rather than the whole of it, precisely so it can be run against a table with history.

It does require **`OWED_AWS_ACCOUNT`**, alongside `OWED_DYNAMO_TABLE` and `AWS_REGION`, and
refuses to start without it:

```bash
OWED_AWS_ACCOUNT=$(aws sts get-caller-identity --query Account --output text) \
OWED_DYNAMO_TABLE=owed-ledger AWS_REGION=us-east-1 pnpm aws:smoke
```

It writes a real household ledger to a real table, so it asserts whose account it is pointed
at before writing anything. That used to default to the author's account number, which both
published it in a public repository and made the guard weaker than it looked — a default is a
value nobody chose, and the check only means something if someone named the account on
purpose.

## The two variables that are not optional

| | |
|---|---|
| `OWED_AUTH_SECRET` | Signs the HS256 tokens, and the household comes from the token's `sub` — so the development default, which is published in this repository, would let anyone mint a token for any household. **The server refuses to boot** on that default, or on anything under 32 bytes, when `OWED_BASE_URL` is not loopback. |
| `OWED_ALLOWED_HOSTS` | Behind a proxy the `Host` header is the public hostname, and the DNS-rebinding validator's default allow-list is loopback only — so **every request 403s** until this is set. Unioned with the loopback names rather than replacing them, because the upstream option replaces. |

`bootstrap.sh` generates both into `/etc/owed/owed.env` (mode 0640, root:owed — Caddy never reads it) and leaves
an existing file alone, because regenerating `OWED_AUTH_SECRET` would invalidate every token
already issued.

## Order of operations

```bash
# 1. the ledger table (see ../readme.md §12.2)
aws dynamodb create-table --table-name owed-ledger ...

# 2. the box: Amazon Linux 2023, arm64, t4g.small
#    security group: 80 and 443 from anywhere, 22 from your address only
#    an Elastic IP, so OWED_BASE_URL and the OAuth redirect origins survive a reboot

# 3. on the box, as root
OWED_REPO=https://github.com/... bash bootstrap.sh owed.example.com owed-ledger us-east-1

# 4. check it
systemctl status owed-server --no-pager
curl -s http://127.0.0.1:3939/health      # on the box: the ledger, not just the port
```

`/health` reads the ledger rather than returning a constant, so it distinguishes
"listening" from "working" — which are different, and were previously indistinguishable.

**It is loopback-only, and the Caddyfile answers 404 for it explicitly.** Not merely
unrouted — without that block `/health` falls through to the static site and returns
`index.html` with a **200**, so a monitor pointed at the public URL would report healthy
forever regardless of the ledger. Verified by running it, which is how that was found — and
asserted since, because `/health` has no token behind it the way `/control/*` does, so that
one block is the whole of its protection.

**Caddy does not probe it either**, and that is deliberate. An earlier version used
`health_uri /health` on the `/mcp` proxy; testing showed Caddy's health checker sends
`Host: <upstream-address>`, the server's DNS-rebinding protection answers 403 to anything
outside its allow-list, and Caddy then pulled the only upstream and served a bare 503 for
all MCP traffic — a healthy server taken down by its own monitoring. The application's own
503 names the reason, which is more useful than Caddy's empty one.

So: curl it **on the box**, over loopback.

**Stop the instance when not demoing.** Stopped, it costs only its EBS volume (~$1.60/mo)
against a ~$14/mo running cost. That lever is most of why this is one VM rather than a
managed topology.
