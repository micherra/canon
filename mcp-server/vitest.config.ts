import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "@app": fileURLToPath(new URL("./src/app", import.meta.url)),
      "@domains": fileURLToPath(new URL("./src/domains", import.meta.url)),
      "@features": fileURLToPath(new URL("./src/features", import.meta.url)),
      "@graph": fileURLToPath(new URL("./src/graph", import.meta.url)),
      "@platform": fileURLToPath(new URL("./src/platform", import.meta.url)),
      "@shared": fileURLToPath(new URL("./src/shared", import.meta.url)),
      "@tests": fileURLToPath(new URL("./src/tests", import.meta.url)),
      "@ui": fileURLToPath(new URL("./src/ui", import.meta.url)),
    },
  },
  test: {
    exclude: ["dist/**", "node_modules/**", "**/*.spec.ts", ".canon/**"],
    // 20s timeout for subprocess-heavy tests (git, depcruise, embeddings).
    // The 5s vitest default trips under parallel load (watch_TTTTTT1/VVVVVV1).
    testTimeout: 20000,
    poolOptions: {
      forks: {
        // Cap fork parallelism to reduce I/O contention in subprocess-heavy suites.
        maxForks: 4,
      },
    },
  },
});
