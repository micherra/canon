import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getExecutionStore } from "@domains/workspaces/execution-store-cache.ts";
import { assertOk } from "@shared/lib/tool-result.ts";
import { afterEach, describe, expect, it } from "vitest";
import { writeContextSync } from "../write-context-sync.ts";

let tmpDir: string;

afterEach(async () => {
  if (tmpDir) await rm(tmpDir, { force: true, recursive: true });
});

describe("writeContextSync — happy path", () => {
  it("writes CONTEXT-SYNC.md and emits a write receipt on UPDATED", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-context-sync-test-"));

    const result = await writeContextSync({
      content: "## Context Sync\n\nUpdated CLAUDE.md.\n",
      slug: "my-epic",
      status: "UPDATED",
      workspace: tmpDir,
    });

    assertOk(result);
    expect(result.path.replaceAll("\\", "/")).toContain("plans/my-epic/CONTEXT-SYNC.md");

    const content = await readFile(result.path, "utf-8");
    expect(content).toContain("Updated CLAUDE.md");

    const store = getExecutionStore(tmpDir);
    const events = store.getEvents({ type: "write_receipt" });
    expect(events).toHaveLength(1);
    expect(events[0].payload.artifact_kind).toBe("context_sync");
  });

  it("also emits a write receipt on NO_UPDATES — a no-op sync still receipts", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-context-sync-test-"));

    const result = await writeContextSync({
      content: "## Context Sync\n\nNo updates needed.\n",
      slug: "my-epic",
      status: "NO_UPDATES",
      workspace: tmpDir,
    });

    assertOk(result);
    const store = getExecutionStore(tmpDir);
    const events = store.getEvents({ type: "write_receipt" });
    expect(events).toHaveLength(1);
    expect(events[0].payload.artifact_kind).toBe("context_sync");
  });
});

describe("writeContextSync — validation errors", () => {
  it("returns INVALID_INPUT when workspace is a relative path", async () => {
    const result = await writeContextSync({
      content: "## Context Sync\n",
      slug: "my-epic",
      status: "UPDATED",
      workspace: "relative/path",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
      expect(result.message).toContain("absolute");
    }
  });

  it("returns INVALID_INPUT for invalid slug", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-context-sync-test-"));

    const result = await writeContextSync({
      content: "## Context Sync\n",
      slug: "bad slug!",
      status: "UPDATED",
      workspace: tmpDir,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error_code).toBe("INVALID_INPUT");
  });

  it("returns INVALID_INPUT for path traversal in slug", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-context-sync-test-"));

    const result = await writeContextSync({
      content: "## Context Sync\n",
      slug: "../evil",
      status: "UPDATED",
      workspace: tmpDir,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error_code).toBe("INVALID_INPUT");
  });
});
