/**
 * Measure every tool's latency against a real server, and commit the result.
 *
 * `readme.md` §10 has pointed at `eval/latency/` since the table was written, and the
 * directory did not exist — the figure it quoted came from a vitest benchmark that timed
 * one tool and printed the number to stdout. This is the harness that row describes.
 *
 * It boots the real MCP server, walks the real OAuth flow, and drives all six tools over
 * Streamable HTTP with a real MCP client — the same shape as `scripts/capture-demo.mjs`,
 * because a latency number taken against anything less than the real transport is a
 * number about something else.
 *
 *   pnpm build && pnpm --filter @owed/eval latency
 */

import { spawn } from "node:child_process";
import { cpus, loadavg } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { linkAccount } from "@owed/mcp-server";
import { type LatencyReport, summarise, verdict } from "../latency/measure.js";
import { writeReport } from "../results.js";

/** Out of the way of `pnpm demo` (3939) and the conformance check (3999). */
const PORT = process.env.OWED_PORT ?? "3994";
const BASE_URL = new URL(`http://127.0.0.1:${PORT}`);
const SAMPLES = Number(process.env.OWED_LATENCY_SAMPLES ?? "50");
const TARGET_MS = 500;
const BOOT_TIMEOUT_MS = 40_000;

/**
 * Resolved from this module, not from the working directory.
 *
 * `pnpm --filter @owed/eval latency` runs with cwd set to `eval/`, so a repo-root-relative
 * path finds nothing and the server dies with MODULE_NOT_FOUND before it can be waited on.
 */
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SERVER_ENTRY = fileURLToPath(
  new URL("../../../packages/mcp-server/dist/main.js", import.meta.url),
);

const server = spawn(process.execPath, [SERVER_ENTRY], {
  cwd: REPO_ROOT,
  env: { ...process.env, OWED_PORT: PORT },
  stdio: ["ignore", "ignore", "inherit"],
});
const stop = () => {
  if (!server.killed) server.kill("SIGTERM");
};
process.on("exit", stop);
process.on("SIGINT", () => {
  stop();
  process.exit(130);
});

async function waitForServer(): Promise<void> {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`server exited early (${server.exitCode})`);
    try {
      const response = await fetch(new URL("/.well-known/oauth-protected-resource", BASE_URL));
      if (response.ok) return;
    } catch {
      // not listening yet
    }
    await delay(250);
  }
  throw new Error(`server did not start within ${BOOT_TIMEOUT_MS}ms`);
}

await waitForServer();

const { accessToken } = await linkAccount({ baseUrl: BASE_URL, clientId: "owed-simulated-home" });
const client = new Client({ name: "owed-latency", version: "1.0.0" });
await client.connect(
  new StreamableHTTPClientTransport(new URL("/mcp", BASE_URL), {
    requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
  }),
);

const { tools } = await client.listTools();

/**
 * `evidence_get` needs an identifier the ledger actually holds, so it is resolved once
 * before the clock starts. Timing the lookup as well would measure two calls and report
 * them as one.
 */
async function argumentsFor(name: string): Promise<Record<string, unknown>> {
  switch (name) {
    case "promise_check":
      return { promise_id: "prm_002" };
    case "claim_status":
      return { claim_id: "clm_002" };
    // Already filed in the seeded week, so this reports rather than negotiating — the
    // write path is not what a household waits on twice.
    case "claim_file":
      return { promise_id: "prm_002" };
    case "evidence_get": {
      const check = await client.callTool({
        name: "promise_check",
        arguments: { promise_id: "prm_002" },
      });
      const items =
        (check.structuredContent as { items?: Array<{ evidence_id: string }> }).items ?? [];
      return { promise_id: "prm_002", evidence_id: items[0]?.evidence_id ?? "evd_missing" };
    }
    default:
      return {};
  }
}

process.stdout.write("\nTool latency\n");
process.stdout.write(
  `  ${tools.length} tools x ${SAMPLES} calls over Streamable HTTP, against a ${TARGET_MS} ms target\n\n`,
);

const measured = [];
for (const tool of tools) {
  const args = await argumentsFor(tool.name);
  // One throwaway call per tool: the first one pays for a cold projection and a warm
  // connection, and reporting it alongside the rest would describe start-up rather than
  // the thing a household experiences.
  await client.callTool({ name: tool.name, arguments: args });

  const durations: number[] = [];
  for (let i = 0; i < SAMPLES; i += 1) {
    const started = performance.now();
    await client.callTool({ name: tool.name, arguments: args });
    durations.push(performance.now() - started);
  }
  measured.push(summarise(tool.name, durations));
}

const { worst, met } = verdict(measured, TARGET_MS);

const report: LatencyReport = {
  measured_at: new Date().toISOString(),
  environment: {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpus: cpus().length,
    load_average_1m: Math.round((loadavg()[0] ?? 0) * 100) / 100,
  },
  target_ms: TARGET_MS,
  samples_per_tool: SAMPLES,
  tools: measured,
  worst,
  met,
};

process.stdout.write(
  `  ${"tool".padEnd(16)}${"min".padStart(8)}${"median".padStart(9)}${"p95".padStart(8)}${"max".padStart(9)}\n`,
);
for (const tool of measured) {
  process.stdout.write(
    `  ${tool.tool.padEnd(16)}${`${tool.min_ms}`.padStart(8)}${`${tool.median_ms}`.padStart(9)}${`${tool.p95_ms}`.padStart(8)}${`${tool.max_ms}`.padStart(9)}\n`,
  );
}

process.stdout.write(
  `\n  worst p95 across the surface  ${worst.tool} at ${worst.p95_ms} ms\n` +
    `  under the ${TARGET_MS} ms target: ${met ? "met" : "NOT met"}\n`,
);
process.stdout.write(
  `\n  Measured on ${report.environment.cpus} cores at load ${report.environment.load_average_1m}.\n` +
    "  Latency is a property of the machine as much as the code; the environment is\n" +
    "  recorded in the result so a figure can never be quoted without one.\n",
);

await client.close();
stop();

process.stdout.write(`\n  written to ${writeReport("latency", report)}\n`);

if (!met) process.exit(1);
