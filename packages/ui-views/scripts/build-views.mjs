#!/usr/bin/env node
/**
 * Build every view, one pass each.
 *
 * `vite-plugin-singlefile` turns code splitting off, so a pass can only carry one entry.
 * Single-file output is the requirement rather than the plugin's preference: an MCP Apps
 * resource is one document handed to a sandboxed iframe that cannot fetch anything else.
 */
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const VIEWS = ["ledger", "claim", "evidence"];

rmSync(fileURLToPath(new URL("../dist/views", import.meta.url)), { recursive: true, force: true });

for (const view of VIEWS) {
  const result = spawnSync("vite", ["build"], {
    stdio: "inherit",
    env: { ...process.env, OWED_VIEW: view },
    shell: process.platform === "win32",
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
