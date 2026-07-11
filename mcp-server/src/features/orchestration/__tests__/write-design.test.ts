import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearStoreCache, getExecutionStore } from "@domains/workspaces/execution-store-cache.ts";
import { assertOk } from "@shared/lib/tool-result.ts";
import { afterEach, describe, expect, it } from "vitest";
import { writeDesign } from "../tools/write-design.ts";
import { seedExecution } from "./seed-execution-test-helper.ts";

let tmpDir: string;

afterEach(async () => {
  clearStoreCache();
  if (tmpDir) {
    await rm(tmpDir, { force: true, recursive: true });
  }
});

describe("writeDesign — fail-closed on unbacked workspace", () => {
  it("returns WORKSPACE_NOT_FOUND and writes no artifact when the workspace has no execution row", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-design-test-"));

    const result = await writeDesign({
      content: "## Design\n",
      slug: "unbacked-slug",
      workspace: tmpDir,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("WORKSPACE_NOT_FOUND");
      expect(result.message).toContain(tmpDir);
    }
    expect(existsSync(join(tmpDir, "plans", "unbacked-slug", "DESIGN.md"))).toBe(false);
  });
});

describe("writeDesign — happy path (seeded workspace)", () => {
  it("writes DESIGN.md and emits a write receipt", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-design-test-"));
    seedExecution(tmpDir);

    const result = await writeDesign({
      content: "## Design: Something\n\nApproach details.",
      slug: "seeded-slug",
      workspace: tmpDir,
    });

    assertOk(result);
    expect(result.path).toContain("DESIGN.md");
    const content = await readFile(result.path, "utf-8");
    expect(content).toContain("Approach details.");

    const store = getExecutionStore(tmpDir);
    const events = store.getEvents({ type: "write_receipt" });
    expect(events).toHaveLength(1);
    expect(events[0].payload.artifact_kind).toBe("design");
  });
});
