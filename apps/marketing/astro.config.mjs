import { defineConfig } from "astro/config";
import { viteCache as forkViteCache } from "../../scripts/lib/fork-build-cache.cjs";

export default defineConfig({
  vite: forkViteCache(import.meta.url),
  site: "https://t3.codes",
  server: {
    port: Number(process.env.PORT ?? 4173),
  },
});
