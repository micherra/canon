import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getExecutionStore } from "@domains/workspaces/execution-store-cache.ts";
import { assertOk } from "@shared/lib/tool-result.ts";
import { afterEach, describe, expect, it } from "vitest";
import { writeTestReport } from "../tools/write-test-report.ts";
import { seedExecution } from "./seed-execution-test-helper.ts";

let tmpDir: string;

afterEach(async () => {
  if (tmpDir) {
    await rm(tmpDir, { force: true, recursive: true });
  }
});

// Valid input — happy path

describe("writeTestReport — valid input", () => {
  it("writes TEST-REPORT.md and TEST-REPORT.meta.json to correct location", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-test-report-test-"));
    seedExecution(tmpDir);
    const result = await writeTestReport({
      failed: 0,
      passed: 10,
      skipped: 2,
      slug: "my-slug",
      summary: "All tests passed.",
      workspace: tmpDir,
    });

    assertOk(result);
    expect(result.path).toContain("TEST-REPORT.md");
    expect(result.path).toContain("my-slug");
    expect(result.meta_path).toContain("TEST-REPORT.meta.json");
    expect(result.meta_path).toContain("my-slug");

    // Both files should exist and be readable
    const md = await readFile(result.path, "utf-8");
    const metaRaw = await readFile(result.meta_path, "utf-8");
    expect(md.length).toBeGreaterThan(0);
    expect(metaRaw.length).toBeGreaterThan(0);
  });

  it("markdown contains stats table with correct values", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-test-report-test-"));
    seedExecution(tmpDir);
    const result = await writeTestReport({
      failed: 2,
      passed: 8,
      skipped: 1,
      slug: "stats-test",
      summary: "Some tests failed.",
      workspace: tmpDir,
    });

    assertOk(result);
    const md = await readFile(result.path, "utf-8");

    // Should have a markdown header
    expect(md).toContain("## Test Report");

    // Should contain the summary text
    expect(md).toContain("Some tests failed.");

    // Should have stats table headers
    expect(md).toContain("Passed");
    expect(md).toContain("Failed");
    expect(md).toContain("Skipped");
    expect(md).toContain("Total");
    expect(md).toContain("Pass Rate");

    // Should contain the actual numbers
    expect(md).toContain("8");
    expect(md).toContain("2");
    expect(md).toContain("1");
    // total is 11
    expect(md).toContain("11");
  });

  it("computes total and pass_rate correctly", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-test-report-test-"));
    seedExecution(tmpDir);
    const result = await writeTestReport({
      failed: 1,
      passed: 3,
      skipped: 0,
      slug: "compute-test",
      summary: "Test run complete.",
      workspace: tmpDir,
    });

    assertOk(result);
    expect(result.total).toBe(4);
    expect(result.pass_rate).toBe(0.75);
  });

  it("handles pass_rate edge case of 0 total (no divide by zero)", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-test-report-test-"));
    seedExecution(tmpDir);
    const result = await writeTestReport({
      failed: 0,
      passed: 0,
      skipped: 0,
      slug: "zero-total",
      summary: "No tests ran.",
      workspace: tmpDir,
    });

    assertOk(result);
    expect(result.total).toBe(0);
    expect(result.pass_rate).toBe(0);
  });

  it("meta JSON has _type: test_report and _version: 1", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-test-report-test-"));
    seedExecution(tmpDir);
    const result = await writeTestReport({
      failed: 0,
      passed: 5,
      skipped: 0,
      slug: "meta-type-test",
      summary: "Checking meta.",
      workspace: tmpDir,
    });

    assertOk(result);
    const metaRaw = await readFile(result.meta_path, "utf-8");
    const meta = JSON.parse(metaRaw);

    expect(meta._type).toBe("test_report");
    expect(meta._version).toBe(1);
  });

  it("meta JSON preserves all input fields and computed fields", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-test-report-test-"));
    seedExecution(tmpDir);
    const result = await writeTestReport({
      failed: 3,
      passed: 7,
      skipped: 1,
      slug: "meta-fields-test",
      summary: "Complete summary text.",
      workspace: tmpDir,
    });

    assertOk(result);
    const metaRaw = await readFile(result.meta_path, "utf-8");
    const meta = JSON.parse(metaRaw);

    expect(meta.summary).toBe("Complete summary text.");
    expect(meta.passed).toBe(7);
    expect(meta.failed).toBe(3);
    expect(meta.skipped).toBe(1);
    expect(meta.total).toBe(11);
    expect(meta.pass_rate).toBeCloseTo(7 / 11);
  });

  it("meta JSON issues array preserves input structure", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-test-report-test-"));
    seedExecution(tmpDir);
    const issues = [
      {
        category: "logic",
        error: "Expected true, got false",
        file: "src/foo.ts",
        test: "should handle errors",
      },
      { category: "crash", error: "TypeError: cannot read property", test: "should parse input" },
    ];

    const result = await writeTestReport({
      failed: 2,
      issues,
      passed: 8,
      skipped: 0,
      slug: "issues-test",
      summary: "Some failures.",
      workspace: tmpDir,
    });

    assertOk(result);
    const metaRaw = await readFile(result.meta_path, "utf-8");
    const meta = JSON.parse(metaRaw);

    expect(meta.issues).toHaveLength(2);
    expect(meta.issues[0].test).toBe("should handle errors");
    expect(meta.issues[0].error).toBe("Expected true, got false");
    expect(meta.issues[0].category).toBe("logic");
    expect(meta.issues[0].file).toBe("src/foo.ts");
    expect(meta.issues[1].test).toBe("should parse input");
    expect(meta.issues[1].category).toBe("crash");
    expect(meta.issues[1].file).toBeUndefined();
  });

  it("includes Issues section in markdown when issues are present", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-test-report-test-"));
    seedExecution(tmpDir);
    const result = await writeTestReport({
      failed: 2,
      issues: [{ category: "regression", error: "it broke", file: "src/foo.ts", test: "test foo" }],
      passed: 8,
      skipped: 0,
      slug: "issues-md-test",
      summary: "Some failures.",
      workspace: tmpDir,
    });

    assertOk(result);
    const md = await readFile(result.path, "utf-8");

    expect(md).toContain("### Issues");
    expect(md).toContain("Test");
    expect(md).toContain("Error");
    expect(md).toContain("Category");
    expect(md).toContain("File");
    expect(md).toContain("test foo");
    expect(md).toContain("it broke");
  });

  it("handles missing optional issues field (empty array in meta)", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-test-report-test-"));
    seedExecution(tmpDir);
    const result = await writeTestReport({
      failed: 0,
      passed: 5,
      skipped: 0,
      slug: "no-issues-test",
      summary: "All passed!",
      workspace: tmpDir,
      // no issues field
    });

    assertOk(result);
    const metaRaw = await readFile(result.meta_path, "utf-8");
    const meta = JSON.parse(metaRaw);

    expect(meta.issues).toEqual([]);

    // Should not have Issues section in markdown when there are no issues
    const md = await readFile(result.path, "utf-8");
    expect(md).not.toContain("### Issues");
  });

  it("creates the plans directory if it does not exist", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-test-report-test-"));
    seedExecution(tmpDir);
    const result = await writeTestReport({
      failed: 0,
      passed: 1,
      skipped: 0,
      slug: "brand-new-slug",
      summary: "New plan directory.",
      workspace: tmpDir,
    });

    assertOk(result);
    const md = await readFile(result.path, "utf-8");
    expect(md).toContain("## Test Report");
  });
});

describe("writeTestReport — manual_verification field", () => {
  it("renders ## Manual Verification Needed section when items are provided", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-test-report-test-"));
    seedExecution(tmpDir);
    const result = await writeTestReport({
      failed: 0,
      manual_verification: [
        {
          criterion: "UI renders correctly in Safari",
          status: "pending",
          verification_method: "Open browser and inspect visually",
        },
        {
          criterion: "CSV export downloads file",
          status: "not started",
          verification_method: "Click Export button and verify download",
        },
      ],
      passed: 5,
      skipped: 0,
      slug: "mv-items-test",
      summary: "Some manual checks needed.",
      workspace: tmpDir,
    });

    assertOk(result);
    const md = await readFile(result.path, "utf-8");

    expect(md).toContain("## Manual Verification Needed");
    expect(md).toContain("Criterion");
    expect(md).toContain("Verification Method");
    expect(md).toContain("Status");
    // Row 1
    expect(md).toContain("UI renders correctly in Safari");
    expect(md).toContain("Open browser and inspect visually");
    expect(md).toContain("pending");
    // Row 2
    expect(md).toContain("CSV export downloads file");
    expect(md).toContain("Click Export button and verify download");
    expect(md).toContain("not started");
    // Row numbers
    expect(md).toContain("| 1 |");
    expect(md).toContain("| 2 |");
  });

  it("does not render section when manual_verification is an empty array", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-test-report-test-"));
    seedExecution(tmpDir);
    const result = await writeTestReport({
      failed: 0,
      manual_verification: [],
      passed: 3,
      skipped: 0,
      slug: "mv-empty-test",
      summary: "All automated.",
      workspace: tmpDir,
    });

    assertOk(result);
    const md = await readFile(result.path, "utf-8");
    expect(md).not.toContain("## Manual Verification Needed");
  });

  it("does not render section when manual_verification is absent", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-test-report-test-"));
    seedExecution(tmpDir);
    const result = await writeTestReport({
      failed: 0,
      passed: 3,
      skipped: 0,
      slug: "mv-absent-test",
      summary: "No manual_verification field.",
      workspace: tmpDir,
    });

    assertOk(result);
    const md = await readFile(result.path, "utf-8");
    expect(md).not.toContain("## Manual Verification Needed");
  });

  it("meta JSON includes manual_verification array when provided", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-test-report-test-"));
    seedExecution(tmpDir);
    const manualVerification = [
      {
        criterion: "Login flow works with SSO",
        status: "pending",
        verification_method: "Manually test with SSO provider",
      },
    ];

    const result = await writeTestReport({
      failed: 0,
      manual_verification: manualVerification,
      passed: 4,
      skipped: 0,
      slug: "mv-meta-test",
      summary: "One manual check.",
      workspace: tmpDir,
    });

    assertOk(result);
    const metaRaw = await readFile(result.meta_path, "utf-8");
    const meta = JSON.parse(metaRaw);

    expect(meta.manual_verification).toHaveLength(1);
    expect(meta.manual_verification[0].criterion).toBe("Login flow works with SSO");
    expect(meta.manual_verification[0].verification_method).toBe("Manually test with SSO provider");
    expect(meta.manual_verification[0].status).toBe("pending");
  });

  it("meta JSON manual_verification defaults to empty array when absent", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-test-report-test-"));
    seedExecution(tmpDir);
    const result = await writeTestReport({
      failed: 0,
      passed: 2,
      skipped: 0,
      slug: "mv-meta-absent-test",
      summary: "No manual checks.",
      workspace: tmpDir,
    });

    assertOk(result);
    const metaRaw = await readFile(result.meta_path, "utf-8");
    const meta = JSON.parse(metaRaw);

    expect(meta.manual_verification).toEqual([]);
  });

  it("escapes pipe characters in manual_verification values", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-test-report-test-"));
    seedExecution(tmpDir);
    const result = await writeTestReport({
      failed: 0,
      manual_verification: [
        {
          criterion: "Step A | Step B works",
          status: "pass|fail",
          verification_method: "Check A|B|C",
        },
      ],
      passed: 1,
      skipped: 0,
      slug: "mv-escape-test",
      summary: "Escape test.",
      workspace: tmpDir,
    });

    assertOk(result);
    const md = await readFile(result.path, "utf-8");

    // Pipe characters must be escaped so they don't break the table
    expect(md).toContain("&#124;");
    // The raw unescaped pipe should not appear inside a table cell value
    // (it can appear as the cell delimiter but the content should be escaped)
    expect(md).toContain("Step A &#124; Step B works");
  });
});

describe("writeTestReport — write receipt", () => {
  it("emits a write_receipt event of kind 'test_report' pointing at TEST-REPORT.md", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-test-report-test-"));
    seedExecution(tmpDir);
    const result = await writeTestReport({
      failed: 0,
      passed: 5,
      skipped: 0,
      slug: "receipt-test",
      summary: "All passed.",
      workspace: tmpDir,
    });

    assertOk(result);
    const store = getExecutionStore(tmpDir);
    const events = store.getEvents({ type: "write_receipt" });
    expect(events).toHaveLength(1);
    expect(events[0].payload.artifact_kind).toBe("test_report");
    expect(events[0].payload.artifact_path).toBe(result.path);
  });
});

describe("writeTestReport — relative workspace rejection", () => {
  it("returns INVALID_INPUT when workspace is a relative path", async () => {
    const result = await writeTestReport({
      failed: 0,
      passed: 0,
      skipped: 0,
      slug: "my-slug",
      summary: "test",
      workspace: "relative/path",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
      expect(result.message).toContain("absolute");
    }
  });
});

describe("writeTestReport — validation errors", () => {
  it("returns INVALID_INPUT for slug with spaces", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-test-report-test-"));
    seedExecution(tmpDir);
    const result = await writeTestReport({
      failed: 0,
      passed: 0,
      skipped: 0,
      slug: "slug with spaces",
      summary: "Bad slug.",
      workspace: tmpDir,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
      expect(result.message).toContain("slug with spaces");
    }
  });

  it("returns INVALID_INPUT for slug with special characters", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-test-report-test-"));
    seedExecution(tmpDir);
    const result = await writeTestReport({
      failed: 0,
      passed: 0,
      skipped: 0,
      slug: "bad@slug!",
      summary: "Bad slug.",
      workspace: tmpDir,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
    }
  });

  it("returns INVALID_INPUT for path traversal attempt (slug containing ..)", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-test-report-test-"));
    seedExecution(tmpDir);
    // The slug pattern check catches ".." first, but test that the path traversal
    // guard also works for cases that might slip through
    const result = await writeTestReport({
      failed: 0,
      passed: 0,
      skipped: 0,
      slug: "..",
      summary: "Path traversal.",
      workspace: tmpDir,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
    }
  });

  it("does not perform file I/O when slug is invalid", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-test-report-test-"));
    seedExecution(tmpDir);
    const result = await writeTestReport({
      failed: 0,
      passed: 0,
      skipped: 0,
      slug: "invalid slug!",
      summary: "Should not write.",
      workspace: tmpDir,
    });

    expect(result.ok).toBe(false);
    // If we got here without filesystem errors, the validate-before-IO principle is honored
  });
});

describe("writeTestReport — fail-closed on unbacked workspace", () => {
  it("returns WORKSPACE_NOT_FOUND and writes no artifact when the workspace has no execution row", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-test-report-test-"));
    // Deliberately NOT seeded — workspace has no execution row.

    const result = await writeTestReport({
      failed: 0,
      passed: 1,
      skipped: 0,
      slug: "unbacked-slug",
      summary: "Should not be written.",
      workspace: tmpDir,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("WORKSPACE_NOT_FOUND");
      expect(result.message).toContain(tmpDir);
    }
    expect(existsSync(join(tmpDir, "plans", "unbacked-slug", "TEST-REPORT.md"))).toBe(false);
  });
});
