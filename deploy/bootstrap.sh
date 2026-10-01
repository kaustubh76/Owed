#!/usr/bin/env bash
#
# Bring up Owed on one Amazon Linux 2023 arm64 instance (t4g.small).
#
# Run as root on a fresh box. Idempotent enough to re-run: it will not regenerate secrets
# that already exist, because doing so would invalidate every linked token.
#
#   sudo bash bootstrap.sh owed.example.com owed-ledger us-east-1
#
# What it deliberately does NOT do:
#   - open any port. Ports 3939-3941 stay on loopback; only Caddy listens publicly, and the
#     security group should allow 80/443 plus 22 from your address alone.
#   - put a secret in this file, in the repo, or in the shell history.
#   - install the AWS CLI credentials. The instance should use an instance role scoped to
#     the one DynamoDB table.

set -euo pipefail

HOSTNAME_PUBLIC="${1:?usage: bootstrap.sh <hostname> <dynamo-table> <region>}"
DYNAMO_TABLE="${2:?missing dynamo table name}"
AWS_REGION_ARG="${3:?missing region}"

# Pinned exactly. `.nvmrc` carries the major; the patch is pinned here so two boxes built a
# month apart run the same runtime.
NODE_VERSION="${NODE_VERSION:-26.0.0}"
CADDY_VERSION="${CADDY_VERSION:-2.8.4}"
PNPM_VERSION="10.18.2"
REPO_DIR=/srv/owed
ENV_FILE=/etc/owed/owed.env

echo "==> packages"
dnf -y update
dnf -y install git tar gzip shadow-utils

# ── node ───────────────────────────────────────────────────────────────────────────────
#
# The official tarball, checksum-verified, rather than `curl … | bash -` from NodeSource.
# Three reasons, in order of how likely each was to bite:
#   1. NodeSource may not publish a setup script for this major on Amazon Linux 2023 at all,
#      and the failure would be a 404 piped into root's shell.
#   2. Piping a remote script into root bash on a box whose job is to hold a JWT signing key
#      is a poor trade for three saved lines.
#   3. The tarball pins the exact version, which is the point of .nvmrc.
echo "==> node ${NODE_VERSION} (linux-arm64)"
if [ "$(node --version 2>/dev/null || echo none)" != "v${NODE_VERSION}" ]; then
	tmp="$(mktemp -d)"
	tarball="node-v${NODE_VERSION}-linux-arm64.tar.xz"
	curl -fsSL -o "${tmp}/${tarball}" "https://nodejs.org/dist/v${NODE_VERSION}/${tarball}"
	curl -fsSL -o "${tmp}/SHASUMS256.txt" "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt"
	(cd "$tmp" && grep " ${tarball}\$" SHASUMS256.txt | sha256sum -c -)
	tar -xJf "${tmp}/${tarball}" -C /usr/local --strip-components=1
	rm -rf "$tmp"
fi
corepack enable
corepack prepare "pnpm@${PNPM_VERSION}" --activate

# ── caddy ──────────────────────────────────────────────────────────────────────────────
#
# The official static binary, not `dnf copr`. `copr` needs dnf-plugins-core and an EPEL 9
# chroot that is not guaranteed to resolve on AL2023 — it was the single likeliest line in
# this file to fail outright, and it would fail after the box was already half configured.
# A static binary has no repo plumbing to go wrong, so it needs a unit file of its own,
# which is shipped alongside this script.
echo "==> caddy ${CADDY_VERSION} (linux-arm64)"
if [ "$(caddy version 2>/dev/null | cut -d' ' -f1)" != "v${CADDY_VERSION}" ]; then
	tmp="$(mktemp -d)"
	curl -fsSL -o "${tmp}/caddy.tar.gz" \
		"https://github.com/caddyserver/caddy/releases/download/v${CADDY_VERSION}/caddy_${CADDY_VERSION}_linux_arm64.tar.gz"
	curl -fsSL -o "${tmp}/checksums.txt" \
		"https://github.com/caddyserver/caddy/releases/download/v${CADDY_VERSION}/caddy_${CADDY_VERSION}_checksums.txt"
	(cd "$tmp" && grep "caddy_${CADDY_VERSION}_linux_arm64.tar.gz\$" checksums.txt | sha256sum -c -)
	tar -xzf "${tmp}/caddy.tar.gz" -C "$tmp" caddy
	install -m 0755 "${tmp}/caddy" /usr/local/bin/caddy
	rm -rf "$tmp"
fi
id -u caddy >/dev/null 2>&1 || useradd --system --home-dir /var/lib/caddy --create-home --shell /sbin/nologin caddy
mkdir -p /etc/caddy /var/lib/caddy
chown -R caddy:caddy /var/lib/caddy

echo "==> user and directories"
id -u owed >/dev/null 2>&1 || useradd --system --home-dir "$REPO_DIR" --shell /sbin/nologin owed
mkdir -p "$REPO_DIR" /etc/owed "$REPO_DIR/data"

echo "==> repo"
if [ -d "$REPO_DIR/.git" ]; then
	git -C "$REPO_DIR" pull --ff-only
else
	# Replace with the real remote; kept as a variable so the script is not wrong the day
	# the repository moves.
	git clone "${OWED_REPO:?set OWED_REPO to the git remote, e.g. OWED_REPO=https://… bash bootstrap.sh …}" "$REPO_DIR"
fi

echo "==> build"
cd "$REPO_DIR"
pnpm install --frozen-lockfile
pnpm build

# The home's brain URL is inlined by Vite at BUILD time, and defaults to
# ws://127.0.0.1:3940. Built without this, the deployed page would tell every visitor's
# browser to connect to *their own* machine — the page would load fine and simply never
# reach "brain connected", which is a maddening thing to debug from the outside.
#
# wss:// because the page is served over https, and mixed-content rules would block ws://.
# The path is /brain to match the Caddyfile; the brain's WebSocketServer sets no `path`
# option, so it accepts the upgrade on any path.
VITE_BRAIN_URL="wss://${HOSTNAME_PUBLIC}/brain" pnpm --filter @owed/home build

echo "==> secrets"
# Generated on the box and never printed. Regenerating OWED_AUTH_SECRET would invalidate
# every token already issued, so an existing file is left exactly as it is.
if [ ! -f "$ENV_FILE" ]; then
	umask 077
	cat >"$ENV_FILE" <<EOF
# Generated by bootstrap.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ). Do not commit.
OWED_BASE_URL=https://${HOSTNAME_PUBLIC}
OWED_ALLOWED_HOSTS=${HOSTNAME_PUBLIC}
OWED_AUTH_SECRET=$(openssl rand -hex 32)
OWED_CONTROL_TOKEN=$(openssl rand -hex 32)
OWED_DYNAMO_TABLE=${DYNAMO_TABLE}
AWS_REGION=${AWS_REGION_ARG}
OWED_MERCHANTS_URL=http://127.0.0.1:3941
EOF
	chown root:owed "$ENV_FILE"
	chmod 0640 "$ENV_FILE"
	echo "    wrote $ENV_FILE (0640 root:owed)"
else
	echo "    $ENV_FILE exists — left alone, so linked tokens stay valid"
fi

chown -R owed:owed "$REPO_DIR"

echo "==> caddy config"
install -m 0644 "$REPO_DIR/deploy/Caddyfile" /etc/caddy/Caddyfile
sed -i "s/owed\.example\.com/${HOSTNAME_PUBLIC}/g" /etc/caddy/Caddyfile
install -m 0644 "$REPO_DIR/deploy/caddy.service" /etc/systemd/system/caddy.service
# Fail before starting rather than after: an invalid Caddyfile here would otherwise leave
# the site down with the error buried in journalctl.
/usr/local/bin/caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile

echo "==> services"

# Check the units point at binaries that exist, before enabling them.
#
# They hardcode absolute paths, and this script installs Node under /usr/local rather than
# from a package — so a unit saying /usr/bin/node would fail with 203/EXEC at start time,
# three services deep, with the cause stated nowhere. Cheaper to notice here.
for unit in "$REPO_DIR"/deploy/owed-*.service "$REPO_DIR/deploy/caddy.service"; do
	binary=$(awk -F'=' '/^ExecStart=/ {split($2, a, " "); print a[1]; exit}' "$unit")
	if [ ! -x "$binary" ]; then
		echo "    FATAL: $(basename "$unit") runs '${binary}', which is not executable here." >&2
		echo "    node is at: $(command -v node || echo 'not found')" >&2
		exit 1
	fi
done
echo "    every ExecStart binary resolves"

install -m 0644 "$REPO_DIR"/deploy/owed-*.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now owed-merchants owed-server owed-brain
systemctl enable --now caddy
systemctl restart caddy

echo
echo "Up. Check with:"
echo "  systemctl status owed-server --no-pager"
echo "  curl -s http://127.0.0.1:3939/health            # the ledger, from on the box"
echo "  curl -s https://${HOSTNAME_PUBLIC}/.well-known/oauth-protected-resource | head -c 200"
echo
echo "The server refuses to boot if OWED_AUTH_SECRET is the development default while"
echo "OWED_BASE_URL is public, so a failed start here is that guard doing its job — read"
echo "the message in: journalctl -u owed-server -n 30 --no-pager"
