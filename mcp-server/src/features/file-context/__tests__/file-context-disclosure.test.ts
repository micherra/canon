import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyFileContextDisclosure,
  summarizeFileContext,
} from "../tools/file-context-disclosure.ts";
import type { FileContextOutput } from "../tools/get-file-context.ts";

function makeOutput(overrides: Partial<FileContextOutput> = {}): FileContextOutput {
  return {
    content: "export function foo() {}",
    exports: ["foo"],
    file_path: "src/api/handler.ts",
    imported_by: [],
    imports: [],
    layer: "api",
    last_verdict: null,
    violation_count: 0,
    violations: [],
    imports_by_layer: {},
    imported_by_layer: {},
    layer_stack: ["api", "shared"],
    project_max_impact: 0,
    role: "internal",
    shape: { description: "Moderate connectivity, typical file.", label: "Internal" },
    summary: null,
    ...overrides,
  };
}

describe("summarizeFileContext", () => {
  it("includes file path and layer", () => {
    const summary = summarizeFileContext(makeOutput());
    expect(summary).toContain("src/api/handler.ts");
    expect(summary).toContain("api");
  });

  it("includes import/export counts", () => {
    const output = makeOutput({
      exports: ["a", "b"],
      imports: ["x"],
      imported_by: ["y", "z"],
    });
    const summary = summarizeFileContext(output);
    expect(summary).toContain("Imports: 1");
    expect(summary).toContain("Imported by: 2");
    expect(summary).toContain("Exports: 2");
  });

  it("includes violations count when present", () => {
    const output = makeOutput({
      violations: [{ principle_id: "p1", severity: "warning" }],
    });
    const summary = summarizeFileContext(output);
    expect(summary).toContain("Violations: 1");
  });

  it("omits violations line when none", () => {
    const summary = summarizeFileContext(makeOutput({ violations: [] }));
    expect(summary).not.toContain("Violations:");
  });

  it("marks hub files", () => {
    const output = makeOutput({
      graph_metrics: {
        in_degree: 10,
        out_degree: 2,
        is_hub: true,
        in_cycle: false,
        cycle_peers: [],
        layer_violation_count: 0,
        impact_score: 0.9,
      },
    });
    const summary = summarizeFileContext(output);
    expect(summary).toContain("Hub file");
  });
});

describe("applyFileContextDisclosure", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "canon-disclosure-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { force: true, recursive: true });
  });

  it("returns output unchanged when payload is small", () => {
    const output = makeOutput();
    const result = applyFileContextDisclosure(output, tmpDir);

    expect(result.truncated).toBeUndefined();
    expect(result.full_data_path).toBeUndefined();
    expect(result.content).toBe(output.content);
  });

  it("truncates and writes file when payload exceeds threshold", () => {
    // Generate a content string large enough to exceed the 12,000-char threshold.
    const largeContent = "x".repeat(15_000);
    const output = makeOutput({ content: largeContent });
    const result = applyFileContextDisclosure(output, tmpDir);

    expect(result.truncated).toBe(true);
    expect(result.full_data_path).toBeDefined();
    expect(result.content).toContain("Truncated");
    expect(result.content).toContain(result.full_data_path);

    // Full data file is written to disk.
    expect(existsSync(result.full_data_path!)).toBe(true);
  });

  it("writes full data to .canon/artifacts under the project dir", () => {
    const largeContent = "x".repeat(15_000);
    const output = makeOutput({ content: largeContent });
    const result = applyFileContextDisclosure(output, tmpDir);

    if (!result.truncated) return; // shouldn't happen given large content
    expect(result.full_data_path).toContain(".canon");
    expect(result.full_data_path).toContain("artifacts");
  });
});
