import { defineConfig } from "astro/config";
import { viteCacheDir as forkViteCacheDir } from "../../scripts/lib/fork-build-cache.cjs";

export default defineConfig({
  vite: { cacheDir: forkViteCacheDir(import.meta.url) },
  site: "https://t3.codes",
  server: {
    port: Number(process.env.PORT ?? 4173),
  },
});
