import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearStoreCache, getExecutionStore } from "@domains/workspaces/execution-store-cache.ts";
import { assertOk } from "@shared/lib/tool-result.ts";
import { afterEach, describe, expect, it } from "vitest";
import { writeContextSync } from "../tools/write-context-sync.ts";
import { seedExecution } from "./seed-execution-test-helper.ts";

let tmpDir: string;

afterEach(async () => {
  clearStoreCache();
  if (tmpDir) {
    await rm(tmpDir, { force: true, recursive: true });
  }
});

describe("writeContextSync — fail-closed on unbacked workspace", () => {
  it("returns WORKSPACE_NOT_FOUND and writes no artifact when the workspace has no execution row", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-context-sync-test-"));

    const result = await writeContextSync({
      content: "## Context Sync\n",
      slug: "unbacked-slug",
      status: "UPDATED",
      workspace: tmpDir,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("WORKSPACE_NOT_FOUND");
      expect(result.message).toContain(tmpDir);
    }
    expect(existsSync(join(tmpDir, "plans", "unbacked-slug", "CONTEXT-SYNC.md"))).toBe(false);
  });
});

describe("writeContextSync — happy path (seeded workspace)", () => {
  it("writes CONTEXT-SYNC.md and emits a write receipt", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-context-sync-test-"));
    seedExecution(tmpDir);

    const result = await writeContextSync({
      content: "## Context Sync\n\nUpdated CLAUDE.md.",
      slug: "seeded-slug",
      status: "UPDATED",
      workspace: tmpDir,
    });

    assertOk(result);
    expect(result.path).toContain("CONTEXT-SYNC.md");
    const content = await readFile(result.path, "utf-8");
    expect(content).toContain("Updated CLAUDE.md.");

    const store = getExecutionStore(tmpDir);
    const events = store.getEvents({ type: "write_receipt" });
    expect(events).toHaveLength(1);
    expect(events[0].payload.artifact_kind).toBe("context_sync");
  });
});
