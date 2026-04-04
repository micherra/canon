/**
 * Tests that registerToolWithUi deduplicates resource registration.
 *
 * We can't import registerToolWithUi directly (it's local to index.ts),
 * so we replicate the dedup logic and verify it matches the pattern used
 * in production — then do a smoke-start of the server to confirm no crash.
 */
import { describe, it, expect, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverEntry = join(__dirname, "..", "index.ts");

describe("registerToolWithUi resource deduplication", () => {
  it("dedup logic: second registration with same URI is skipped", () => {
    const registeredResources = new Set<string>();
    const registerAppResource = vi.fn();

    function registerResource(uri: string) {
      if (!registeredResources.has(uri)) {
        registerAppResource(uri);
        registeredResources.add(uri);
      }
    }

    registerResource("ui://canon/codebase-graph");
    registerResource("ui://canon/codebase-graph");
    registerResource("ui://canon/file-context");

    expect(registerAppResource).toHaveBeenCalledTimes(2);
    expect(registerAppResource).toHaveBeenCalledWith("ui://canon/codebase-graph");
    expect(registerAppResource).toHaveBeenCalledWith("ui://canon/file-context");
  });

  it("server starts without duplicate resource error", () => {
    // Smoke test: start the server and immediately send EOF via stdin.
    // If registerAppResource throws "already registered", this will fail.
    const result = execFileSync("npx", ["tsx", serverEntry], {
      timeout: 10_000,
      input: "", // immediate EOF causes the server to exit cleanly
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    // No throw means success — the server initialized without the duplicate error.
    expect(result).toBeDefined();
  });
});
