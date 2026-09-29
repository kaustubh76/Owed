import { STORYBOARD_MERCHANTS } from "../presets.js";
import { createMerchantAgentsApp, merchantSlug } from "../server.js";

const PORT = Number(process.env.OWED_MERCHANTS_PORT ?? 3941);

createMerchantAgentsApp().listen(PORT, "127.0.0.1", () => {
  process.stdout.write(`Merchant agents on http://127.0.0.1:${PORT}\n`);
  for (const config of STORYBOARD_MERCHANTS) {
    process.stdout.write(`  /mcp/${merchantSlug(config.merchant)}  ${config.merchant}\n`);
  }
});
