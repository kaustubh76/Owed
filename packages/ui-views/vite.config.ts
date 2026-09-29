import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

/**
 * One view per build.
 *
 * `vite-plugin-singlefile` turns code splitting off, which rules out multiple inputs in a
 * single pass — and single-file output is the requirement, not the plugin: an MCP Apps
 * resource is one document handed to a sandboxed iframe that cannot fetch anything else.
 */
const VIEWS = ["ledger", "claim", "evidence"] as const;

const view = process.env.OWED_VIEW ?? "ledger";
if (!VIEWS.includes(view as (typeof VIEWS)[number])) {
  throw new Error(`OWED_VIEW must be one of ${VIEWS.join(", ")}, got "${view}"`);
}

export default defineConfig({
  plugins: [react(), viteSingleFile()],
  root: fileURLToPath(new URL("./src", import.meta.url)),
  build: {
    outDir: fileURLToPath(new URL("./dist/views", import.meta.url)),
    // Each pass adds one view; the build script clears the directory once up front.
    emptyOutDir: false,
    rollupOptions: {
      input: { [view]: fileURLToPath(new URL(`./src/${view}/index.html`, import.meta.url)) },
    },
  },
});
