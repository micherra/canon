import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearStoreCache, getExecutionStore } from "@domains/workspaces/execution-store-cache.ts";
import { assertOk } from "@shared/lib/tool-result.ts";
import { afterEach, describe, expect, it } from "vitest";
import { writeSecurityAssessment } from "../tools/write-security-assessment.ts";
import { seedExecution } from "./seed-execution-test-helper.ts";

let tmpDir: string;

afterEach(async () => {
  clearStoreCache();
  if (tmpDir) {
    await rm(tmpDir, { force: true, recursive: true });
  }
});

describe("writeSecurityAssessment — fail-closed on unbacked workspace", () => {
  it("returns WORKSPACE_NOT_FOUND and writes no artifact when the workspace has no execution row", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-security-assessment-test-"));

    const result = await writeSecurityAssessment({
      content: "## Security Assessment\n",
      slug: "unbacked-slug",
      workspace: tmpDir,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("WORKSPACE_NOT_FOUND");
      expect(result.message).toContain(tmpDir);
    }
    expect(existsSync(join(tmpDir, "plans", "unbacked-slug", "SECURITY.md"))).toBe(false);
  });
});

describe("writeSecurityAssessment — happy path (seeded workspace)", () => {
  it("writes SECURITY.md and emits a write receipt", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-security-assessment-test-"));
    seedExecution(tmpDir);

    const result = await writeSecurityAssessment({
      content: "## Security Assessment\n\nNo critical findings.",
      slug: "seeded-slug",
      workspace: tmpDir,
    });

    assertOk(result);
    expect(result.path).toContain("SECURITY.md");
    const content = await readFile(result.path, "utf-8");
    expect(content).toContain("No critical findings.");

    const store = getExecutionStore(tmpDir);
    const events = store.getEvents({ type: "write_receipt" });
    expect(events).toHaveLength(1);
    expect(events[0].payload.artifact_kind).toBe("security_assessment");
  });
});
