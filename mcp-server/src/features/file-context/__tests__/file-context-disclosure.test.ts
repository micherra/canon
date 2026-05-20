import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
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
    imported_by_layer: {},
    imports: [],
    imports_by_layer: {},
    last_verdict: null,
    layer: "api",
    layer_stack: ["api", "shared"],
    project_max_impact: 0,
    role: "internal",
    shape: { description: "Moderate connectivity, typical file.", label: "Internal" },
    summary: null,
    violation_count: 0,
    violations: [],
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
      imported_by: ["y", "z"],
      imports: ["x"],
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
        cycle_peers: [],
        impact_score: 0.9,
        in_cycle: false,
        in_degree: 10,
        is_hub: true,
        layer_violation_count: 0,
        out_degree: 2,
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

  it("returns output unchanged when payload is small", async () => {
    const output = makeOutput();
    const result = await applyFileContextDisclosure(output, tmpDir);

    expect(result.truncated).toBeUndefined();
    expect(result.full_data_path).toBeUndefined();
    expect(result.content).toBe(output.content);
  });

  it("truncates and writes file when payload exceeds threshold", async () => {
    // Generate a content string large enough to exceed the 12,000-char threshold.
    const largeContent = "x".repeat(15_000);
    const output = makeOutput({ content: largeContent });
    const result = await applyFileContextDisclosure(output, tmpDir);

    expect(result.truncated).toBe(true);
    expect(result.full_data_path).toBeDefined();
    expect(result.content).toContain("Truncated");
    expect(result.content).toContain(result.full_data_path);

    // Full data file is written to disk.
    expect(existsSync(result.full_data_path!)).toBe(true);
  });

  it("strips large fields from truncated output", async () => {
    const largeContent = "x".repeat(15_000);
    const output = makeOutput({
      blast_radius: { direct: [], total_affected: 5, transitive: [] } as never,
      co_change_partners: [{ co_change_count: 3, confidence: 0.8, file_path: "x.ts" }] as never,
      content: largeContent,
      entities: [
        { is_exported: true, kind: "function" as never, line_end: 5, line_start: 1, name: "foo" },
      ],
      violations: [{ principle_id: "p1", severity: "warning" }],
    });
    const result = await applyFileContextDisclosure(output, tmpDir);

    expect(result.truncated).toBe(true);
    expect(result.blast_radius).toBeUndefined();
    expect(result.entities).toBeUndefined();
    expect(result.co_change_partners).toBeUndefined();
    expect(result.hotspot_score).toBeUndefined();
    expect(result.violations).toEqual([]);
    expect(result.imports).toEqual([]);
    expect(result.exports).toEqual([]);
    // Routing metadata preserved
    expect(result.file_path).toBe(output.file_path);
    expect(result.layer).toBe(output.layer);
    // summary is the disclosure-generated string (not the original null)
    expect(typeof result.summary).toBe("string");
    expect(result.summary).toContain("src/api/handler.ts");
  });

  it("writes full data to .canon/artifacts under the project dir", async () => {
    const largeContent = "x".repeat(15_000);
    const output = makeOutput({ content: largeContent });
    const result = await applyFileContextDisclosure(output, tmpDir);

    if (!result.truncated) return; // shouldn't happen given large content
    expect(result.full_data_path).toContain(".canon");
    expect(result.full_data_path).toContain("artifacts");
  });
});
