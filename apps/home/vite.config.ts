import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, host: "127.0.0.1" },
  /**
   * `site`, not `dist`, and that is a bug fix.
   *
   * `apps/home/tsconfig.json` compiles to `dist` with `noEmit: false`, and this used to
   * build there too — so the directory held whichever of the two ran last. `deploy/Caddyfile`
   * serves it as the public site, which meant a routine `pnpm build` (which runs `tsc -b`)
   * silently replaced the live site with `.js` and `.d.ts` modules and no `index.html`.
   * Caddy would answer 404 and nothing on the box would look wrong.
   */
  build: { outDir: "site" },
});
