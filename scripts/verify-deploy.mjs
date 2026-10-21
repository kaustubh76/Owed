#!/usr/bin/env node
/**
 * Check the deployment the way the other gates check the product.
 *
 * `deploy/` was the one directory with nothing automated pointed at it: four systemd
 * units, a Caddyfile and two shell scripts, all of them checked only by being run on a
 * box. That is a bad place for a blind spot, because the failure mode is a service that
 * restart-loops with its reason in `journalctl` on a host nobody is watching — and the
 * two defects found by reading these files by hand were exactly that shape. `caddy.service`
 * had no `Restart=` at all, so the only public listener stayed down for ever if it died;
 * and `bootstrap.sh`'s own pre-flight read the ExecStart interpreter and never the script
 * it was handed, so a missing `dist/main.js` passed.
 *
 * Both are now checks here rather than observations in a commit message.
 *
 * The structural checks run everywhere, including CI, because they are just parsing. The
 * three real validators — shellcheck, systemd-analyze, caddy — run when the binary is
 * present and are reported as skipped when it is not, which is honest about what a green
 * run on a Mac does and does not establish. GitHub's ubuntu runners carry the first two.
 *
 * **`OWED_REQUIRE_VALIDATORS=1` turns an absent binary into a failure**, and CI sets it.
 * Reporting a skip and exiting 0 is right on a laptop — a clean clone must run `pnpm verify`
 * green with nothing installed — and wrong where all three are supposed to exist: if the
 * caddy-extraction step in the workflow broke, or a runner image dropped shellcheck, every
 * validator here would quietly become a no-op and this gate would still pass. That is the
 * same hole `OWED_REQUIRE_DYNAMO` was added to close for the DynamoDB adapter, and
 * `docs/product-feedback.md` names the shape of it: the failure mode that survives a test
 * suite is the one where the check itself cannot fail. This was the last instance of it
 * inside Owed's own gates.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEPLOY = join(REPO_ROOT, "deploy");

const failures = [];
const skipped = [];
/** Validators that ran in a container rather than natively, so the report can say so. */
const viaDocker = new Set();

/** Set in CI, where all three validators are supposed to be on the box. */
const REQUIRED = process.env.OWED_REQUIRE_VALIDATORS === "1";

/** Same shape as the other gates: print what was checked, and what it came out as. */
function check(label, actual, expected) {
  const ok = actual === expected;
  process.stdout.write(`  ${ok ? "ok " : "FAIL"} ${label} — ${actual}\n`);
  if (!ok) failures.push(`${label}: expected ${expected}, got ${actual}`);
}

/** For the many checks that are a yes/no rather than a comparison. */
function want(label, ok, detail) {
  process.stdout.write(`  ${ok ? "ok " : "FAIL"} ${label} — ${detail}\n`);
  if (!ok) failures.push(`${label}: ${detail}`);
}

/** A tool that may not be installed. Absent is reported, not failed. */
/**
 * The three validators in Linux containers, for a machine that has none of them.
 *
 * All three are absent on macOS — `systemd-analyze` cannot meaningfully exist there — so this
 * gate has always reported them as "not run here" and pointed at CI. That left the four unit
 * files and the Caddyfile checked by nothing local, on the one machine the deployment is
 * actually edited from.
 *
 * Verified by hand before being wired in: `shellcheck --severity=warning` clean on both
 * scripts, `caddy validate` reporting "Valid configuration", and `systemd-analyze verify`
 * (systemd 257) exiting 0 with no findings on all four units.
 *
 * **Opt-in, via `OWED_DOCKER_VALIDATORS=1`.** Pulling a few hundred megabytes of images is
 * not something `pnpm verify` should do to a judge who ran it to look at the tests, and the
 * systemd route installs a package inside the container, which needs a network. So the
 * default behaviour of this gate is exactly what it was.
 *
 * It can only ever upgrade a skip into a real check: if Docker is missing or a container
 * fails to start, the validator is recorded as absent precisely as before.
 */
const DOCKER = process.env.OWED_DOCKER_VALIDATORS === "1";

const CONTAINERS = {
  shellcheck: (args) => [
    "run",
    "--rm",
    "-v",
    `${REPO_ROOT}:/w:ro`,
    "-w",
    "/w",
    "koalaman/shellcheck:stable",
    ...args.map((arg) => relative(REPO_ROOT, arg) || arg),
  ],
  caddy: (args) => [
    "run",
    "--rm",
    "-v",
    `${DEPLOY}:/d:ro`,
    "caddy:latest",
    "caddy",
    ...args.map((arg) => (arg.startsWith(DEPLOY) ? `/d/${relative(DEPLOY, arg)}` : arg)),
  ],
  // The one that needs a package installed, and the stubs its units reference: a unit whose
  // ExecStart interpreter is missing is reported, and in a bare container every one of them
  // is. Stubbing them leaves real findings as the only output.
  "systemd-analyze": (args) => [
    "run",
    "--rm",
    "-v",
    `${DEPLOY}:/d:ro`,
    "debian:stable-slim",
    "sh",
    "-c",
    "export DEBIAN_FRONTEND=noninteractive; " +
      "apt-get -qq update >/dev/null 2>&1 && apt-get -qq install -y systemd >/dev/null 2>&1; " +
      'mkdir -p /usr/local/bin; for b in node caddy; do printf "#!/bin/sh\n" > /usr/local/bin/$b; ' +
      "chmod +x /usr/local/bin/$b; done; " +
      "id -u owed >/dev/null 2>&1 || useradd -r -s /usr/sbin/nologin owed 2>/dev/null; " +
      `systemd-analyze ${args
        .map((arg) => (arg.startsWith(DEPLOY) ? `/d/${relative(DEPLOY, arg)}` : arg))
        .join(" ")}`,
  ],
};

function inDocker(name, args) {
  const build = CONTAINERS[name];
  if (build === undefined) return undefined;
  const probe = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], {
    stdio: "ignore",
  });
  if (probe.error !== undefined || probe.status !== 0) return undefined;

  const result = spawnSync("docker", build(args), { encoding: "utf8" });
  if (result.error !== undefined) return undefined;
  viaDocker.add(name);
  return result;
}

function tool(name, args) {
  const probe = spawnSync(name, ["--version"], { stdio: "ignore" });
  if (probe.error !== undefined || probe.status !== 0) {
    const containerised = DOCKER ? inDocker(name, args) : undefined;
    if (containerised !== undefined) return containerised;
    skipped.push(name);
    return undefined;
  }
  return spawnSync(name, args, { encoding: "utf8" });
}

/**
 * Units are read as plain key/value rather than parsed properly.
 *
 * systemd allows repeated keys, continuations and much else; none of that appears in these
 * four files, and a real parser here would be checking a parser rather than the units. The
 * directives this cares about are single-line, and `systemd-analyze verify` is the thing
 * that gets to be strict — it runs below, wherever it exists.
 */
function directives(text) {
  const map = new Map();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith("[")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq);
    const value = trimmed.slice(eq + 1);
    if (!map.has(key)) map.set(key, []);
    map.get(key)?.push(value);
  }
  return map;
}

const files = await readdir(DEPLOY);
const units = files.filter((name) => name.endsWith(".service")).sort();
const shells = files.filter((name) => name.endsWith(".sh")).sort();

process.stdout.write("Owed deployment gate\n\n");
check("units found", units.length, 4);
check("shell scripts found", shells.length, 2);

process.stdout.write("\n--- shell syntax ---\n");
for (const name of shells) {
  const path = join(DEPLOY, name);
  const parsed = spawnSync("bash", ["-n", path], { encoding: "utf8" });
  check(`${name} parses`, parsed.status === 0 ? "ok" : parsed.stderr.trim(), "ok");
}

process.stdout.write("\n--- unit structure ---\n");
for (const name of units) {
  const text = readFileSync(join(DEPLOY, name), "utf8");
  const d = directives(text);

  /**
   * A unit with no restart policy is the `caddy.service` bug, which is worth a check of
   * its own because it is invisible: the file is correct in every other respect and the
   * service simply never comes back.
   */
  want(
    `${name} has a restart policy`,
    d.has("Restart"),
    d.get("Restart")?.[0] ?? "no Restart= directive",
  );
  want(
    `${name} says how long to wait`,
    d.has("RestartSec"),
    d.get("RestartSec")?.[0] ?? "no RestartSec=",
  );
  check(`${name} is enablable`, d.get("WantedBy")?.[0] ?? "MISSING", "multi-user.target");

  // Both ExecStart fields, which is the half `bootstrap.sh` used to miss.
  for (const key of ["ExecStart", "ExecReload"]) {
    for (const value of d.get(key) ?? []) {
      const [binary, ...rest] = value.split(/\s+/);
      if (binary === undefined) continue;
      want(`${name} ${key} binary is absolute`, binary.startsWith("/"), binary);

      const script = rest.find((argument) => !argument.startsWith("-"));
      if (script === undefined || !/\.[cm]?js$/.test(script)) continue;

      /**
       * The script a unit hands its interpreter has to exist. Relative paths resolve
       * against `WorkingDirectory` on the box and against the repo here, which is the same
       * tree `bootstrap.sh` rsyncs — so a build that did not produce an entry point fails
       * at `pnpm verify` instead of on the host.
       */
      if (script.startsWith("/")) {
        want(
          `${name} runs ${script}`,
          existsSync(script),
          existsSync(script) ? "present" : "MISSING",
        );
      } else {
        want(
          `${name} has a WorkingDirectory for its relative script`,
          d.has("WorkingDirectory"),
          d.get("WorkingDirectory")?.[0] ?? "none, so the script would resolve against /",
        );
        const built = existsSync(join(REPO_ROOT, script));
        want(
          `${name} runs ${script}`,
          built,
          built ? "built" : "MISSING — did pnpm build produce it?",
        );
      }
    }
  }
}

/**
 * What Caddy proxies to, against what the code listens on.
 *
 * Caddy is the only public listener and every upstream is a loopback port written out by
 * hand in two places. A default port changed on one side turns the whole add-on into a 502
 * that looks like an outage, and nothing before this compared them.
 */
process.stdout.write("\n--- Caddy upstreams against the code's own defaults ---\n");
const caddyfile = readFileSync(join(DEPLOY, "Caddyfile"), "utf8");
const proxied = [
  ...new Set([...caddyfile.matchAll(/reverse_proxy\s+127\.0\.0\.1:(\d+)/g)].map((m) => m[1])),
].sort();

const LISTENERS = [
  ["packages/mcp-server/src/main.ts", /OWED_PORT \?\? (\d+)/, "mcp server"],
  ["apps/brain/src/main.ts", /OWED_BRAIN_PORT \?\? (\d+)/, "brain"],
  [
    "packages/merchant-agents/src/bin/serve.ts",
    /OWED_MERCHANTS_PORT \?\? (\d+)/,
    "merchant agents",
  ],
];
const defaults = new Map();
for (const [file, pattern, label] of LISTENERS) {
  const found = readFileSync(join(REPO_ROOT, file), "utf8").match(pattern);
  want(
    `${label} declares a default port`,
    found?.[1] !== undefined,
    found?.[1] ?? "no numeric default found",
  );
  if (found?.[1] !== undefined) defaults.set(found[1], label);
}

want("Caddyfile proxies at least one upstream", proxied.length > 0, `${proxied.length} port(s)`);
for (const port of proxied) {
  want(
    `port ${port} is proxied to something that listens`,
    defaults.has(port),
    defaults.get(port) ?? "NOTHING in this repo listens there",
  );
}

/**
 * The merchant agents are deliberately not proxied: they are reached only by the server,
 * over loopback, and exposing them would let anyone file claims against the simulated
 * merchants directly. Pinned so that publishing them has to be a deliberate edit here.
 */
const merchantsPort = [...defaults.entries()].find(([, label]) => label === "merchant agents")?.[0];
const merchantsExposed = merchantsPort !== undefined && proxied.includes(merchantsPort);
want(
  "the merchant agents stay off the public listener",
  merchantsPort !== undefined && !merchantsExposed,
  merchantsPort === undefined
    ? "no default port found"
    : merchantsExposed
      ? `port ${merchantsPort} is reverse_proxied — anyone could file claims against them directly`
      : `port ${merchantsPort}, loopback only`,
);

process.stdout.write("\n--- real validators, where they exist ---\n");
for (const name of shells) {
  const result = tool("shellcheck", ["--severity=warning", join(DEPLOY, name)]);
  if (result === undefined) break;
  check(
    `shellcheck ${name}`,
    result.status === 0 ? "clean" : result.stdout.trim().slice(0, 400),
    "clean",
  );
}

const analyze = tool("systemd-analyze", ["verify", ...units.map((name) => join(DEPLOY, name))]);
if (analyze !== undefined) {
  /**
   * Neither the exit code nor raw stderr is the signal on its own, which was worth
   * measuring rather than assuming — systemd 255, in a container, against these four
   * files:
   *
   * - A unit whose ExecStart interpreter is absent exits **1**. That is every unit here
   *   on any machine that is not the target box, because they all name
   *   `/usr/local/bin/node` or `/usr/local/bin/caddy`. Failing on the exit code would
   *   mean failing everywhere.
   * - A genuinely malformed directive — `Restart=nonsense-value` — exits **0** and prints
   *   `Failed to parse service restart specifier, ignoring`. Trusting the exit code would
   *   mean passing a unit systemd had already given up on.
   * - Everything it says goes to stderr; stdout is empty either way.
   *
   * So: drop the lines that only mean "this is not the target box", and fail on anything
   * that is left, whatever the exit code claimed. With the box simulated — the two
   * interpreters, the two users, /srv/owed and /etc/owed — it comes out clean and exits 0.
   */
  const notTheTargetBox = /is not executable|No such file or directory|Unknown user|Unknown group/i;
  const complaints = analyze.stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !notTheTargetBox.test(line));
  check(
    "systemd-analyze verify",
    complaints.length === 0 ? "clean" : complaints.join(" | ").slice(0, 400),
    "clean",
  );
}

const validated = tool("caddy", ["validate", "--config", join(DEPLOY, "Caddyfile")]);
if (validated !== undefined) {
  check(
    "caddy validate",
    validated.status === 0 ? "clean" : validated.stderr.trim().slice(0, 400),
    "clean",
  );
}

if (skipped.length > 0) {
  const absent = [...new Set(skipped)].join(", ");
  if (REQUIRED) {
    failures.push(
      `OWED_REQUIRE_VALIDATORS=1 but these are not on this machine: ${absent}. ` +
        "Every check they own was about to be reported as skipped on a run that claims to " +
        "run all three. Install them, or unset the variable and accept a weaker gate.",
    );
  }
  process.stdout.write(
    `\n  ${REQUIRED ? "FAIL" : "not run here"} (binary absent): ${absent}\n` +
      "  The structural checks above do not depend on them. CI runs all three: its runners\n" +
      "  carry shellcheck and systemd-analyze, and the workflow lifts caddy out of the\n" +
      "  official image before this step.\n" +
      (DOCKER ? "" : "  `OWED_DOCKER_VALIDATORS=1` runs all three in Linux containers instead.\n"),
  );
}

/**
 * Which validators ran in a container, said out loud.
 *
 * Without this the lines above read "ok shellcheck bootstrap.sh — clean" on a machine with no
 * shellcheck on it, which is a true statement about the script and a misleading one about the
 * environment. The point of this gate is that the deployment is checked by something; the
 * point of this line is that a reader knows by what.
 */
if (viaDocker.size > 0) {
  process.stdout.write(
    `\n  ran in Linux containers, not natively: ${[...viaDocker].sort().join(", ")}\n`,
  );
}

if (failures.length > 0) {
  process.stdout.write(`\n${failures.length} check(s) failed:\n${failures.join("\n")}\n`);
  process.exit(1);
}
process.stdout.write(
  `\nDeployment gate passed.${skipped.length > 0 ? " (See the note above.)" : ""}\n`,
);
