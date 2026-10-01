import { cpus } from "node:os";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const pkg = (name: string) =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

/**
 * Half the cores, at least two.
 *
 * Vitest defaults to a worker per file and this suite has thirty of them, most of which
 * boot a real HTTP server on an ephemeral port — so the default oversubscribes an
 * eight-core machine by roughly four to one. The symptom was not slowness but
 * *unreliability*: failures that moved between files run to run, and the latency benchmark
 * in `alexa/contract.test.ts` measuring 1986 ms against its 500 ms target on one run and
 * 50 ms on the next with no code change in between. Load average reached 441.
 *
 * Half the cores leaves room for the servers the tests themselves spawn, which the worker
 * count does not account for. `isolate: false` would be the faster fix and is the wrong
 * one: it shares workers across files, and 325 tests is a lot of module state to start
 * trusting with that.
 */
const maxWorkers = Math.max(2, Math.floor(cpus().length / 2));

export default defineConfig({
  resolve: {
    alias: {
      "@owed/domain": pkg("domain"),
      "@owed/core": pkg("core"),
      "@owed/recourse-protocol": pkg("recourse-protocol"),
      "@owed/policy-library": pkg("policy-library"),
      "@owed/merchant-agents": pkg("merchant-agents"),
      // Aliased for the same reason as the five above: without it this resolves through the
      // workspace symlink to built `dist`, so a bare `pnpm test` after an edit tests the
      // last build rather than the working tree. `@owed/extractor` and `@owed/mcp-server`
      // are deliberately left on `dist` — the extractor's published numbers are measured
      // against what it ships, and the brain's tests exercise the server as a consumer
      // would.
      "@owed/extractor-bedrock": pkg("extractor-bedrock"),
    },
  },
  test: {
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts", "eval/**/*.test.ts"],
    environment: "node",
    maxWorkers,
    minWorkers: 1,
  },
});
