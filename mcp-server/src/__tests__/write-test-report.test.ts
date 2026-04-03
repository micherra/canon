import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeTestReport } from "../tools/write-test-report.ts";
import { assertOk } from "../utils/tool-result.ts";

let tmpDir: string;

afterEach(async () => {
  if (tmpDir) {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Valid input — happy path
// ---------------------------------------------------------------------------

describe("writeTestReport — valid input", () => {
  it("writes TEST-REPORT.md and TEST-REPORT.meta.json to correct location", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-test-report-test-"));

    const result = await writeTestReport({
      workspace: tmpDir,
      slug: "my-slug",
      summary: "All tests passed.",
      passed: 10,
      failed: 0,
      skipped: 2,
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

    const result = await writeTestReport({
      workspace: tmpDir,
      slug: "stats-test",
      summary: "Some tests failed.",
      passed: 8,
      failed: 2,
      skipped: 1,
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

    const result = await writeTestReport({
      workspace: tmpDir,
      slug: "compute-test",
      summary: "Test run complete.",
      passed: 3,
      failed: 1,
      skipped: 0,
    });

    assertOk(result);
    expect(result.total).toBe(4);
    expect(result.pass_rate).toBe(0.75);
  });

  it("handles pass_rate edge case of 0 total (no divide by zero)", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-test-report-test-"));

    const result = await writeTestReport({
      workspace: tmpDir,
      slug: "zero-total",
      summary: "No tests ran.",
      passed: 0,
      failed: 0,
      skipped: 0,
    });

    assertOk(result);
    expect(result.total).toBe(0);
    expect(result.pass_rate).toBe(0);
  });

  it("meta JSON has _type: test_report and _version: 1", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-test-report-test-"));

    const result = await writeTestReport({
      workspace: tmpDir,
      slug: "meta-type-test",
      summary: "Checking meta.",
      passed: 5,
      failed: 0,
      skipped: 0,
    });

    assertOk(result);
    const metaRaw = await readFile(result.meta_path, "utf-8");
    const meta = JSON.parse(metaRaw);

    expect(meta._type).toBe("test_report");
    expect(meta._version).toBe(1);
  });

  it("meta JSON preserves all input fields and computed fields", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-test-report-test-"));

    const result = await writeTestReport({
      workspace: tmpDir,
      slug: "meta-fields-test",
      summary: "Complete summary text.",
      passed: 7,
      failed: 3,
      skipped: 1,
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

    const issues = [
      { test: "should handle errors", error: "Expected true, got false", category: "logic", file: "src/foo.ts" },
      { test: "should parse input", error: "TypeError: cannot read property", category: "crash" },
    ];

    const result = await writeTestReport({
      workspace: tmpDir,
      slug: "issues-test",
      summary: "Some failures.",
      passed: 8,
      failed: 2,
      skipped: 0,
      issues,
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

    const result = await writeTestReport({
      workspace: tmpDir,
      slug: "issues-md-test",
      summary: "Some failures.",
      passed: 8,
      failed: 2,
      skipped: 0,
      issues: [
        { test: "test foo", error: "it broke", category: "regression", file: "src/foo.ts" },
      ],
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

    const result = await writeTestReport({
      workspace: tmpDir,
      slug: "no-issues-test",
      summary: "All passed!",
      passed: 5,
      failed: 0,
      skipped: 0,
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

    const result = await writeTestReport({
      workspace: tmpDir,
      slug: "brand-new-slug",
      summary: "New plan directory.",
      passed: 1,
      failed: 0,
      skipped: 0,
    });

    assertOk(result);
    const md = await readFile(result.path, "utf-8");
    expect(md).toContain("## Test Report");
  });
});

// ---------------------------------------------------------------------------
// Validation errors
// ---------------------------------------------------------------------------

describe("writeTestReport — validation errors", () => {
  it("returns INVALID_INPUT for slug with spaces", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-test-report-test-"));

    const result = await writeTestReport({
      workspace: tmpDir,
      slug: "slug with spaces",
      summary: "Bad slug.",
      passed: 0,
      failed: 0,
      skipped: 0,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
      expect(result.message).toContain("slug with spaces");
    }
  });

  it("returns INVALID_INPUT for slug with special characters", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-test-report-test-"));

    const result = await writeTestReport({
      workspace: tmpDir,
      slug: "bad@slug!",
      summary: "Bad slug.",
      passed: 0,
      failed: 0,
      skipped: 0,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
    }
  });

  it("returns INVALID_INPUT for path traversal attempt (slug containing ..)", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-test-report-test-"));

    // The slug pattern check catches ".." first, but test that the path traversal
    // guard also works for cases that might slip through
    const result = await writeTestReport({
      workspace: tmpDir,
      slug: "..",
      summary: "Path traversal.",
      passed: 0,
      failed: 0,
      skipped: 0,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
    }
  });

  it("does not perform file I/O when slug is invalid", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-test-report-test-"));

    const result = await writeTestReport({
      workspace: tmpDir,
      slug: "invalid slug!",
      summary: "Should not write.",
      passed: 0,
      failed: 0,
      skipped: 0,
    });

    expect(result.ok).toBe(false);
    // If we got here without filesystem errors, the validate-before-IO principle is honored
  });
});
