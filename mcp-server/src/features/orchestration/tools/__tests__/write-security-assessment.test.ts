import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getExecutionStore } from "@domains/workspaces/execution-store-cache.ts";
import { assertOk } from "@shared/lib/tool-result.ts";
import { afterEach, describe, expect, it } from "vitest";
import { writeSecurityAssessment } from "../write-security-assessment.ts";

let tmpDir: string;

afterEach(async () => {
  if (tmpDir) await rm(tmpDir, { force: true, recursive: true });
});

describe("writeSecurityAssessment — happy path", () => {
  it("writes SECURITY.md to plans/{slug}/SECURITY.md and emits a write receipt", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-security-test-"));

    const result = await writeSecurityAssessment({
      content: "## Security Assessment: full-scan\n\nstatus: CLEAN\n",
      slug: "my-epic",
      workspace: tmpDir,
    });

    assertOk(result);
    expect(result.path.replaceAll("\\", "/")).toContain("plans/my-epic/SECURITY.md");

    const content = await readFile(result.path, "utf-8");
    expect(content).toContain("Security Assessment");

    const store = getExecutionStore(tmpDir);
    const events = store.getEvents({ type: "write_receipt" });
    expect(events).toHaveLength(1);
    expect(events[0].payload.artifact_kind).toBe("security_assessment");
    expect(events[0].payload.artifact_path).toBe(result.path);
  });
});

describe("writeSecurityAssessment — validation errors", () => {
  it("returns INVALID_INPUT when workspace is a relative path", async () => {
    const result = await writeSecurityAssessment({
      content: "## Security Assessment\n",
      slug: "my-epic",
      workspace: "relative/path",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
      expect(result.message).toContain("absolute");
    }
  });

  it("returns INVALID_INPUT for invalid slug", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-security-test-"));

    const result = await writeSecurityAssessment({
      content: "## Security Assessment\n",
      slug: "bad slug!",
      workspace: tmpDir,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error_code).toBe("INVALID_INPUT");
  });

  it("returns INVALID_INPUT for path traversal in slug", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-security-test-"));

    const result = await writeSecurityAssessment({
      content: "## Security Assessment\n",
      slug: "../evil",
      workspace: tmpDir,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error_code).toBe("INVALID_INPUT");
  });
});
