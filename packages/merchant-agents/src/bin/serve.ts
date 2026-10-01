import { STORYBOARD_MERCHANTS } from "../presets.js";
import { createMerchantAgentsApp, merchantSlug } from "../server.js";

const PORT = Number(process.env.OWED_MERCHANTS_PORT ?? 3941);

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** Say why, before exiting. See the same block in the MCP server's `main.ts`. */
process.on("unhandledRejection", (reason) => {
  process.stderr.write(`owed merchants: unhandled rejection: ${describeError(reason)}\n`);
  process.exit(1);
});
process.on("uncaughtException", (error) => {
  process.stderr.write(`owed merchants: uncaught exception: ${describeError(error)}\n`);
  process.exit(1);
});

const http = createMerchantAgentsApp().listen(PORT, "127.0.0.1", () => {
  process.stdout.write(`Merchant agents on http://127.0.0.1:${PORT}\n`);
  for (const config of STORYBOARD_MERCHANTS) {
    process.stdout.write(`  /mcp/${merchantSlug(config.merchant)}  ${config.merchant}\n`);
  }
});

function shutdown(signal: string): void {
  process.stdout.write(`owed merchants: ${signal}, closing\n`);
  http.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
