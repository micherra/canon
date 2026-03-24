import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "src/__tests__",
  testMatch: "**/*.spec.ts",
  timeout: 30_000,
  use: {
    headless: true,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
