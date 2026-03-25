import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "src/__tests__",
  testMatch: "**/*.spec.ts",
  timeout: 60_000,
  use: {
    headless: true,
    // Note: WebGL is not available in headless Chromium on this machine.
    // Tests that need Sigma (WebGL) use a canvas mock injected via page.addInitScript.
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
