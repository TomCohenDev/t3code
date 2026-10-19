import "vite-plus/test/config";
import { viteCache as forkViteCache } from "../../scripts/lib/fork-build-cache.cjs";
import { defineConfig } from "vite-plus";

export default defineConfig({
  ...forkViteCache(import.meta.url),
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    setupFiles: ["../shared/src/testing/longTempDir.ts"],
  },
});
