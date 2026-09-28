import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const pkg = (name: string) =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@owed/domain": pkg("domain"),
      "@owed/core": pkg("core"),
      "@owed/recourse-protocol": pkg("recourse-protocol"),
      "@owed/policy-library": pkg("policy-library"),
      "@owed/merchant-agents": pkg("merchant-agents"),
    },
  },
  test: {
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts", "eval/**/*.test.ts"],
    environment: "node",
  },
});
