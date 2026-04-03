import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, readFile, access } from "fs/promises";
import path from "path";
import os from "os";
import { writeHandoff } from "../tools/write-handoff.ts";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "write-handoff-test-"));
  // Create the handoffs/ directory that writeHandoff writes into
  await mkdir(path.join(tmpDir, "handoffs"), { recursive: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Happy-path: each of the 4 handoff types
// ---------------------------------------------------------------------------

describe("writeHandoff — research-synthesis", () => {
  it("writes a file named research-synthesis.md in handoffs/", async () => {
    const result = await writeHandoff({
      workspace: tmpDir,
      type: "research-synthesis",
      content: {
        key_findings: "Found X",
        affected_subsystems: "auth, db",
        risk_areas: "none",
        open_questions: "How does Y work?",
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.path).toBe(path.join(tmpDir, "handoffs", "research-synthesis.md"));
    expect(result.type).toBe("research-synthesis");
    await expect(access(result.path)).resolves.toBeUndefined();
  });

  it("includes all field headings in the output markdown", async () => {
    const result = await writeHandoff({
      workspace: tmpDir,
      type: "research-synthesis",
      content: {
        key_findings: "Finding A",
        affected_subsystems: "subsystem B",
        risk_areas: "risk C",
        open_questions: "question D",
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const content = await readFile(result.path, "utf-8");
    expect(content).toContain("## key_findings");
    expect(content).toContain("Finding A");
    expect(content).toContain("## affected_subsystems");
    expect(content).toContain("subsystem B");
    expect(content).toContain("## risk_areas");
    expect(content).toContain("risk C");
    expect(content).toContain("## open_questions");
    expect(content).toContain("question D");
  });
});

describe("writeHandoff — design-brief", () => {
  it("writes a file named design-brief.md in handoffs/", async () => {
    const result = await writeHandoff({
      workspace: tmpDir,
      type: "design-brief",
      content: {
        approach: "Use X pattern",
        file_targets: "src/foo.ts",
        constraints: "must be backward compat",
        test_expectations: "unit tests for all branches",
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.path).toBe(path.join(tmpDir, "handoffs", "design-brief.md"));
    expect(result.type).toBe("design-brief");
  });

  it("includes all design-brief headings in markdown", async () => {
    const result = await writeHandoff({
      workspace: tmpDir,
      type: "design-brief",
      content: {
        approach: "approach text",
        file_targets: "targets text",
        constraints: "constraints text",
        test_expectations: "expectations text",
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const content = await readFile(result.path, "utf-8");
    expect(content).toContain("## approach");
    expect(content).toContain("## file_targets");
    expect(content).toContain("## constraints");
    expect(content).toContain("## test_expectations");
  });
});

describe("writeHandoff — impl-handoff", () => {
  it("writes a file named impl-handoff.md in handoffs/", async () => {
    const result = await writeHandoff({
      workspace: tmpDir,
      type: "impl-handoff",
      content: {
        files_changed: "src/a.ts, src/b.ts",
        coverage_notes: "tested happy path",
        risk_areas: "edge case in fn X",
        compliance_status: "COMPLIANT",
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.path).toBe(path.join(tmpDir, "handoffs", "impl-handoff.md"));
    expect(result.type).toBe("impl-handoff");
  });
});

describe("writeHandoff — test-findings", () => {
  it("writes a file named test-findings.md in handoffs/", async () => {
    const result = await writeHandoff({
      workspace: tmpDir,
      type: "test-findings",
      content: {
        failure_details: "3 tests failed",
        reproduction_steps: "run npm test",
        affected_files: "src/foo.test.ts",
        categories: "unit",
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.path).toBe(path.join(tmpDir, "handoffs", "test-findings.md"));
    expect(result.type).toBe("test-findings");
  });
});

// ---------------------------------------------------------------------------
// Error cases
// ---------------------------------------------------------------------------

describe("writeHandoff — invalid type", () => {
  it("returns toolError INVALID_INPUT for unknown type", async () => {
    const result = await writeHandoff({
      workspace: tmpDir,
      type: "bad-type" as "research-synthesis",
      content: {
        key_findings: "x",
        affected_subsystems: "y",
        risk_areas: "z",
        open_questions: "q",
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error_code).toBe("INVALID_INPUT");
  });
});

describe("writeHandoff — missing required content fields", () => {
  it("returns toolError INVALID_INPUT when content field is missing", async () => {
    const result = await writeHandoff({
      workspace: tmpDir,
      type: "research-synthesis",
      content: {
        key_findings: "x",
        // missing: affected_subsystems, risk_areas, open_questions
      } as Record<string, string>,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error_code).toBe("INVALID_INPUT");
  });

  it("returns toolError INVALID_INPUT when a content field is not a string", async () => {
    const result = await writeHandoff({
      workspace: tmpDir,
      type: "research-synthesis",
      content: {
        key_findings: 42 as unknown as string,
        affected_subsystems: "a",
        risk_areas: "b",
        open_questions: "c",
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error_code).toBe("INVALID_INPUT");
  });
});

describe("writeHandoff — path traversal rejection", () => {
  it("rejects a type string containing ../", async () => {
    // The type is validated first, so an attempted traversal via type field
    // should be caught by the allowed-values check before path construction.
    const result = await writeHandoff({
      workspace: tmpDir,
      type: "../evil" as "research-synthesis",
      content: {
        key_findings: "x",
        affected_subsystems: "y",
        risk_areas: "z",
        open_questions: "q",
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error_code).toBe("INVALID_INPUT");
  });
});

describe("writeHandoff — workspace path validation", () => {
  it("returns WORKSPACE_NOT_FOUND for invalid workspace path when validation is active", async () => {
    const orig = process.env.VITEST;
    delete process.env.VITEST;
    try {
      const result = await writeHandoff({
        workspace: "/tmp/not-a-workspace",
        type: "research-synthesis",
        content: {
          key_findings: "x", affected_subsystems: "y",
          risk_areas: "z", open_questions: "q",
        },
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error_code).toBe("WORKSPACE_NOT_FOUND");
    } finally {
      process.env.VITEST = orig;
    }
  });
});

describe("writeHandoff — filesystem write error", () => {
  it("returns UNEXPECTED error code when atomicWriteFile fails", async () => {
    // Use a workspace path that passes assertWorkspacePath (has .canon/workspaces/ segment)
    // but point it to a directory that doesn't exist so mkdir succeeds but write fails
    // We'll use a valid-looking workspace path and make the handoffs dir a file (not a dir)
    // so mkdir fails, which now returns WORKSPACE_NOT_FOUND.
    // For UNEXPECTED from atomicWriteFile, we need mkdir to succeed but write to fail.
    // We simulate this by making the target path (research-synthesis.md) a directory.
    const { mkdtemp, mkdir: fsMkdir, rm: fsRm } = await import("fs/promises");
    const os = await import("os");
    const path = await import("path");

    const fakeWorkspace = await mkdtemp(path.join(os.tmpdir(), "write-handoff-unexpected-"));
    // Create handoffs/ and then create research-synthesis.md as a directory
    // so the write will fail (can't write a file where a directory exists)
    await fsMkdir(path.join(fakeWorkspace, "handoffs", "research-synthesis.md"), { recursive: true });

    const orig = process.env.VITEST;
    delete process.env.VITEST;
    // Temporarily set the env var that skips workspace validation
    process.env.CANON_SKIP_WORKSPACE_VALIDATION = "true";
    try {
      const result = await writeHandoff({
        workspace: fakeWorkspace,
        type: "research-synthesis",
        content: {
          key_findings: "x", affected_subsystems: "y",
          risk_areas: "z", open_questions: "q",
        },
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error_code).toBe("UNEXPECTED");
    } finally {
      process.env.VITEST = orig;
      delete process.env.CANON_SKIP_WORKSPACE_VALIDATION;
      await fsRm(fakeWorkspace, { recursive: true, force: true });
    }
  });
});
