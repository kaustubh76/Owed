import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const entry = (name: string) => fileURLToPath(new URL(`./src/${name}/index.html`, import.meta.url));

/**
 * Each view builds to one self-contained HTML file with no external requests, which
 * is what an MCP Apps resource must be: the server serves the file as the body of a
 * `ui://` resource and the host renders it in a sandboxed iframe.
 */
export default defineConfig({
  plugins: [react(), viteSingleFile()],
  root: fileURLToPath(new URL("./src", import.meta.url)),
  build: {
    outDir: fileURLToPath(new URL("./dist/views", import.meta.url)),
    emptyOutDir: true,
    rollupOptions: {
      input: { ledger: entry("ledger") },
    },
  },
});
