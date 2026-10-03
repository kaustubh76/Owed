# deploy/

One box, Caddy in front, three Node services on loopback. Nothing here is needed to run or
judge the demo — `pnpm demo` is unchanged and still needs no account and no keys.

| File | |
|---|---|
| `Caddyfile` | The entire public surface. Validated against real Caddy. Deliberately does **not** proxy `/control/*`. |
| `caddy.service` | Shipped because Caddy installs as a static binary here, so there is no packaged unit. |
| `owed-server.service`, `owed-brain.service`, `owed-merchants.service` | One process each, so a crash is visible and restartable rather than one shell holding three. |
| `bootstrap.sh` | Amazon Linux 2023 arm64, run once as root. Installs checksum-verified Node and Caddy, builds, writes `/etc/owed/owed.env`, enables the units. |
| `iam-policy-phase1.json` | Least privilege for the Phase 1 smoke test: the ledger table and nothing else. |
| `create-cli-user.sh` | Creates that policy, a user, and an access key — **run it in AWS CloudShell**, which is already authenticated as the console user and so needs no key to create one. Self-contained, because CloudShell has no checkout; its inline policy is kept byte-identical to the JSON above. |

## Two things that will look like bugs and are not

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
forever regardless of the ledger. Verified by running it, which is how that was found.

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
