import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearStoreCache } from "@domains/workspaces/execution-store-cache.ts";
import { afterEach, describe, expect, it } from "vitest";
import { assertWorkspaceInitialized } from "../services/validate-workspace-initialized.ts";
import { seedExecution } from "./seed-execution-test-helper.ts";

let tmpDir: string;

afterEach(async () => {
  clearStoreCache();
  if (tmpDir) {
    await rm(tmpDir, { force: true, recursive: true });
  }
});

describe("assertWorkspaceInitialized", () => {
  it("returns a WORKSPACE_NOT_FOUND error for a non-existent absolute path", () => {
    const nonExistent = join(tmpdir(), "assert-workspace-initialized-does-not-exist");

    const result = assertWorkspaceInitialized(nonExistent);

    expect(result).not.toBeNull();
    expect(result?.error_code).toBe("WORKSPACE_NOT_FOUND");
    expect(result?.message).toContain(nonExistent);
  });

  it("returns a WORKSPACE_NOT_FOUND error for an existing but uninitialized directory", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "assert-workspace-initialized-test-"));

    const result = assertWorkspaceInitialized(tmpDir);

    expect(result).not.toBeNull();
    expect(result?.error_code).toBe("WORKSPACE_NOT_FOUND");
    expect(result?.message).toContain(tmpDir);
  });

  it("returns null for a seeded (initialized) workspace", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "assert-workspace-initialized-test-"));
    seedExecution(tmpDir);

    const result = assertWorkspaceInitialized(tmpDir);

    expect(result).toBeNull();
  });
});
