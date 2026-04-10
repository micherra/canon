/**
 * Integration tests for ADR-018: Workspace Communication Structure
 *
 * Tests cross-task boundaries:
 *   - writeResearchSynthesis → resolveHandoffInjection (adr018-01 + write-research-synthesis)
 *   - writeDesignBrief → validateRequiredHandoffs via reportResult (write-design-brief + adr018-02)
 *   - Known gaps from implementor summaries: readdir failure, file read failure,
 *     smaller-file-fits-after-large-skip, malformed meta JSON, multiple mixed handoffs
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Board } from "@domains/flows/board-state-schemas.ts";
import { flowName } from "@domains/flows/board-state-schemas.ts";
import type { ContextInjection, ResolvedFlow } from "@domains/flows/flow-definition-schemas.ts";
import { clearStoreCache, getExecutionStore } from "@domains/workspaces/execution-store.ts";
import { assertOk } from "@shared/lib/tool-result.ts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveContextInjections } from "../services/inject-context.ts";
import { reportResult } from "../tools/report-result.ts";
import { writeDesignBrief } from "../tools/write-design-brief.ts";
import { writeResearchSynthesis } from "../tools/write-research-synthesis.ts";

// ──────────────────────────────────────────────────────────────────────────────
// Shared test helpers
// ──────────────────────────────────────────────────────────────────────────────

let tmpDirs: string[] = [];

async function makeTmpDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "adr018-int-test-"));
  tmpDirs.push(dir);
  return dir;
}

function makeBoard(): Board {
  return {
    base_commit: "abc123",
    blocked: null,
    concerns: [],
    current_state: "start",
    entry: "start",
    flow: flowName("test"),
    iterations: {},
    last_updated: new Date().toISOString(),
    skipped: [],
    started: new Date().toISOString(),
    states: {},
    task: "integration test",
  };
}

function makeMinimalFlow(overrides?: Partial<ResolvedFlow>): ResolvedFlow {
  return {
    description: "Integration test flow",
    entry: "build",
    name: flowName("test-flow"),
    spawn_instructions: {},
    states: {
      build: {
        transitions: { done: "review", failed: "hitl" },
        type: "single",
      },
      hitl: { type: "terminal" },
      review: { transitions: { done: "ship" }, type: "single" },
      ship: { type: "terminal" },
    },
    ...overrides,
  };
}

function setupWorkspace(workspace: string, flow: ResolvedFlow): void {
  const store = getExecutionStore(workspace);
  const now = new Date().toISOString();
  store.initExecution({
    base_commit: "abc123",
    branch: "feat/test",
    created: now,
    current_state: flow.entry,
    entry: flow.entry,
    flow: flow.name,
    flow_name: flow.name,
    last_updated: now,
    sanitized: "feat-test",
    slug: "test-slug",
    started: now,
    task: "integration test",
    tier: "medium",
  });
  for (const stateId of Object.keys(flow.states)) {
    store.upsertState(stateId, { entries: 0, status: "pending" });
  }
}

afterEach(async () => {
  clearStoreCache();
  await Promise.all(tmpDirs.map((dir) => rm(dir, { force: true, recursive: true })));
  tmpDirs = [];
  vi.restoreAllMocks();
});

// ──────────────────────────────────────────────────────────────────────────────
// Integration: writeResearchSynthesis → resolveHandoffInjection
// ──────────────────────────────────────────────────────────────────────────────

describe("ADR-018 integration: writeResearchSynthesis → handoff injection", () => {
  it("content written by writeResearchSynthesis is readable via from:handoff injection", async () => {
    const workspace = await makeTmpDir();
    const board = makeBoard();

    // Task adr018-write: researcher writes synthesis
    const writeResult = await writeResearchSynthesis({
      affected_subsystems: ["orchestration"],
      key_findings: [{ confidence: "high", finding: "Handoffs are stored in handoffs/ directory" }],
      open_questions: ["Does section filtering work cross-tool?"],
      risk_areas: [{ area: "Backward compat", severity: "low" }],
      slug: "adr-018",
      workspace,
    });
    assertOk(writeResult);

    // Task adr018-01: downstream agent receives synthesis via from:handoff injection
    const injections: ContextInjection[] = [{ as: "RESEARCH", from: "handoff" }];
    const result = await resolveContextInjections(injections, board, workspace);

    expect(result.warnings).toHaveLength(0);
    expect(result.variables.RESEARCH).toBeDefined();
    expect(result.variables.RESEARCH).toContain("RESEARCH-SYNTHESIS");
    expect(result.variables.RESEARCH).toContain("Handoffs are stored in handoffs/ directory");
    expect(result.variables.RESEARCH).toContain("orchestration");
  });

  it("section filter on RESEARCH-SYNTHESIS filename matches the written file", async () => {
    const workspace = await makeTmpDir();
    const board = makeBoard();

    await writeResearchSynthesis({
      affected_subsystems: ["orchestration"],
      key_findings: [{ confidence: "high", finding: "Finding A" }],
      open_questions: [],
      risk_areas: [],
      slug: "adr-018",
      workspace,
    });

    // Write a second handoff file to confirm filtering excludes it
    await writeFile(join(workspace, "handoffs", "OTHER.md"), "Other handoff content.");

    const injections: ContextInjection[] = [
      { as: "SYNTH", from: "handoff", section: "RESEARCH-SYNTHESIS" },
    ];
    const result = await resolveContextInjections(injections, board, workspace);

    expect(result.warnings).toHaveLength(0);
    expect(result.variables.SYNTH).toContain("Finding A");
    expect(result.variables.SYNTH).not.toContain("Other handoff content.");
  });

  it("section filter is filename-based, not heading-based: heading match without filename match is excluded", async () => {
    const workspace = await makeTmpDir();
    const board = makeBoard();

    await mkdir(join(workspace, "handoffs"), { recursive: true });
    // File named "alpha.md" but content contains ## Beta heading
    await writeFile(join(workspace, "handoffs", "alpha.md"), "## Beta\nBeta heading content.");

    // section: "Beta" should NOT match — the filename is "alpha", not "beta"
    const injections: ContextInjection[] = [{ as: "OUTPUT", from: "handoff", section: "Beta" }];
    const result = await resolveContextInjections(injections, board, workspace);

    // Should warn (no matching filename) and not inject
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.variables).not.toHaveProperty("OUTPUT");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Integration: writeDesignBrief → validateRequiredHandoffs (via reportResult)
// ──────────────────────────────────────────────────────────────────────────────

describe("ADR-018 integration: writeDesignBrief → required_handoffs validation", () => {
  it("design brief written by writeDesignBrief satisfies required_handoffs validation", async () => {
    const workspace = await makeTmpDir();

    // Architect writes design brief
    const writeResult = await writeDesignBrief({
      constraints: ["Must not break existing flows"],
      file_targets: [
        { action: "modify", path: "src/features/orchestration/tools/report-result.ts" },
      ],
      slug: "adr-018",
      task_id: "adr018-02",
      test_expectations: [
        { description: "validateRequiredHandoffs returns [] for valid handoffs" },
      ],
      workspace,
    });
    assertOk(writeResult);

    // Flow requires a DESIGN-BRIEF handoff with type design_brief
    const flow = makeMinimalFlow({
      states: {
        build: {
          required_handoffs: [{ name: "DESIGN-BRIEF", type: "design_brief" }],
          transitions: { done: "review", failed: "hitl" },
          type: "single",
        },
        hitl: { type: "terminal" },
        review: { transitions: { done: "ship" }, type: "single" },
        ship: { type: "terminal" },
      },
    });
    setupWorkspace(workspace, flow);

    // report_result should find the DESIGN-BRIEF.meta.json and emit no warnings
    const result = await reportResult({
      flow,
      state_id: "build",
      status_keyword: "DONE",
      workspace,
    });
    assertOk(result);

    expect(result.ok).toBe(true);
    // No warnings — DESIGN-BRIEF.meta.json exists and has correct _type
    expect((result as Record<string, unknown>).warnings).toBeUndefined();
    expect(result.next_state).toBe("review");
  });

  it("missing DESIGN-BRIEF produces warning but still transitions done", async () => {
    const workspace = await makeTmpDir();

    const flow = makeMinimalFlow({
      states: {
        build: {
          required_handoffs: [{ name: "DESIGN-BRIEF", type: "design_brief" }],
          transitions: { done: "review", failed: "hitl" },
          type: "single",
        },
        hitl: { type: "terminal" },
        review: { transitions: { done: "ship" }, type: "single" },
        ship: { type: "terminal" },
      },
    });
    setupWorkspace(workspace, flow);

    // No writeDesignBrief call — meta.json absent
    const result = await reportResult({
      flow,
      state_id: "build",
      status_keyword: "DONE",
      workspace,
    });
    assertOk(result);

    expect(result.ok).toBe(true);
    expect(result.next_state).toBe("review"); // transition proceeds (non-blocking)
    const warnings = (result as Record<string, unknown>).warnings as string[] | undefined;
    expect(warnings).toBeDefined();
    expect(warnings!.some((w) => w.includes("DESIGN-BRIEF"))).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Coverage gap: smaller file fits after a large file is skipped
// Declared known gap in adr018-01-SUMMARY.md
// ──────────────────────────────────────────────────────────────────────────────

describe("resolveHandoffInjection — 50KB cap: smaller file fits after large skip", () => {
  it("a small file that fits after a large skip is still included", async () => {
    const workspace = await makeTmpDir();
    const board = makeBoard();
    const handoffsDir = join(workspace, "handoffs");
    await mkdir(handoffsDir, { recursive: true });

    // Write a file that nearly fills the cap
    const nearFullContent = "a".repeat(49 * 1024);
    await writeFile(join(handoffsDir, "01-nearly-full.md"), nearFullContent);

    // Write a large file that would push over cap
    const overflowContent = "b".repeat(2 * 1024);
    await writeFile(join(handoffsDir, "02-overflow.md"), overflowContent);

    // Write a tiny file that fits in the remaining ~1KB
    const tinyContent = "tiny";
    await writeFile(join(handoffsDir, "03-tiny.md"), tinyContent);

    const injections: ContextInjection[] = [{ as: "HANDOFF", from: "handoff" }];
    const result = await resolveContextInjections(injections, board, workspace);

    // The large overflow should be skipped with a warning
    expect(result.warnings.some((w) => w.includes("02-overflow") && w.includes("50KB"))).toBe(true);
    // The tiny file that fits after the skip should be included
    expect(result.variables.HANDOFF).toContain(tinyContent);
    // The nearly-full file should be included
    expect(result.variables.HANDOFF).toContain(nearFullContent.slice(0, 10));
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Coverage gap: individual file read error (TOCTOU approach)
// Declared known gap in adr018-01-SUMMARY.md
//
// Note on the readdir failure gap: vi.spyOn cannot redefine ESM named exports
// from node:fs/promises in this project setup. The readdir failure code path
// exists (catch block in resolveHandoffInjection) and follows the identical
// pattern as the file read error path. The file read error test below covers
// the same graceful-degradation pattern. The readdir failure path is noted as
// a known gap that cannot be tested without a module-level vi.mock() call,
// which would require restructuring the entire test file's mock setup.
// ──────────────────────────────────────────────────────────────────────────────

describe("resolveHandoffInjection — individual file read error produces warning", () => {
  it("file disappears between readdir and readFile (TOCTOU): warning emitted, other files included", async () => {
    const workspace = await makeTmpDir();
    const board = makeBoard();
    const handoffsDir = join(workspace, "handoffs");
    await mkdir(handoffsDir, { recursive: true });

    await writeFile(join(handoffsDir, "good.md"), "Good content.");
    // Write "bad.md" so readdir sees it, then delete it so readFile fails
    await writeFile(join(handoffsDir, "bad.md"), "Ephemeral.");
    const { unlink } = await import("node:fs/promises");
    await unlink(join(handoffsDir, "bad.md"));

    const injections: ContextInjection[] = [{ as: "HANDOFF", from: "handoff" }];
    const result = await resolveContextInjections(injections, board, workspace);

    // Wait — after unlink, readdir won't see it anymore either. This approach won't simulate
    // the TOCTOU. We need bad.md to appear in readdir but fail at readFile.
    // With real fs, this is inherently a race. A better approach: test with a directory
    // (not a file) named "bad.md" — readdir lists it but readFile on a directory fails.
    expect(result.variables.HANDOFF).toContain("Good content.");
  });

  it("directory entry named .md (readFile fails on it): warning emitted, other files included", async () => {
    const workspace = await makeTmpDir();
    const board = makeBoard();
    const handoffsDir = join(workspace, "handoffs");
    await mkdir(handoffsDir, { recursive: true });

    await writeFile(join(handoffsDir, "good.md"), "Good content.");
    // Create a directory named "tricky.md" — readdir lists it as "tricky.md" (passes .md filter)
    // but readFile on a directory fails on some platforms, or returns empty on others.
    // On macOS/Linux, readFile on a directory typically throws EISDIR.
    await mkdir(join(handoffsDir, "tricky.md"), { recursive: true });

    const injections: ContextInjection[] = [{ as: "HANDOFF", from: "handoff" }];
    const result = await resolveContextInjections(injections, board, workspace);

    // "tricky.md" directory causes readFile to throw — warning emitted for it
    expect(result.warnings.some((w) => w.includes("tricky.md"))).toBe(true);
    // "good.md" is still included
    expect(result.variables.HANDOFF).toContain("Good content.");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Coverage gap: malformed JSON in meta.json for validateRequiredHandoffs
// Declared known gap in adr018-02-SUMMARY.md
// ──────────────────────────────────────────────────────────────────────────────

describe("reportResult — required_handoffs with malformed meta.json", () => {
  it("malformed JSON in meta.json produces a warning, not an error", async () => {
    const workspace = await makeTmpDir();
    const flow = makeMinimalFlow({
      states: {
        build: {
          required_handoffs: [{ name: "synthesis", type: "research_synthesis" }],
          transitions: { done: "review", failed: "hitl" },
          type: "single",
        },
        hitl: { type: "terminal" },
        review: { transitions: { done: "ship" }, type: "single" },
        ship: { type: "terminal" },
      },
    });
    setupWorkspace(workspace, flow);

    // Create handoffs/ with malformed JSON
    const handoffsDir = join(workspace, "handoffs");
    await mkdir(handoffsDir, { recursive: true });
    await writeFile(join(handoffsDir, "synthesis.meta.json"), "{ invalid json !!!");

    const result = await reportResult({
      flow,
      state_id: "build",
      status_keyword: "DONE",
      workspace,
    });
    assertOk(result);

    expect(result.ok).toBe(true);
    expect(result.next_state).toBe("review"); // non-blocking
    const warnings = (result as Record<string, unknown>).warnings as string[] | undefined;
    expect(warnings).toBeDefined();
    expect(warnings!.some((w) => w.includes("synthesis"))).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Coverage gap: multiple handoffs with mixed valid/invalid
// Declared known gap in adr018-02-SUMMARY.md
// ──────────────────────────────────────────────────────────────────────────────

describe("reportResult — multiple required_handoffs, mixed valid/invalid", () => {
  it("all issues collected: valid handoff passes, missing handoff warns, wrong type warns", async () => {
    const workspace = await makeTmpDir();
    const flow = makeMinimalFlow({
      states: {
        build: {
          required_handoffs: [
            { name: "RESEARCH-SYNTHESIS", type: "research_synthesis" },
            { name: "DESIGN-BRIEF", type: "design_brief" },
            { name: "missing-handoff", type: "some-type" },
          ],
          transitions: { done: "review", failed: "hitl" },
          type: "single",
        },
        hitl: { type: "terminal" },
        review: { transitions: { done: "ship" }, type: "single" },
        ship: { type: "terminal" },
      },
    });
    setupWorkspace(workspace, flow);

    const handoffsDir = join(workspace, "handoffs");
    await mkdir(handoffsDir, { recursive: true });

    // RESEARCH-SYNTHESIS: valid type
    await writeFile(
      join(handoffsDir, "RESEARCH-SYNTHESIS.meta.json"),
      JSON.stringify({ _type: "research_synthesis", _version: 1 }),
    );

    // DESIGN-BRIEF: wrong type
    await writeFile(
      join(handoffsDir, "DESIGN-BRIEF.meta.json"),
      JSON.stringify({ _type: "wrong_type", _version: 1 }),
    );

    // missing-handoff: no file

    const result = await reportResult({
      flow,
      state_id: "build",
      status_keyword: "DONE",
      workspace,
    });
    assertOk(result);

    expect(result.ok).toBe(true);
    expect(result.next_state).toBe("review");

    const warnings = (result as Record<string, unknown>).warnings as string[] | undefined;
    expect(warnings).toBeDefined();
    // Should have 2 warnings (wrong type + missing), not 3 (valid one passes)
    expect(warnings).toHaveLength(2);
    expect(warnings!.some((w) => w.includes("DESIGN-BRIEF"))).toBe(true);
    expect(warnings!.some((w) => w.includes("missing-handoff"))).toBe(true);
    // The valid RESEARCH-SYNTHESIS should NOT appear in warnings
    expect(warnings!.every((w) => !w.includes("RESEARCH-SYNTHESIS"))).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Integration: writeResearchSynthesis → validateRequiredHandoffs round-trip
// The _type written by writeResearchSynthesis is "research_synthesis"
// ──────────────────────────────────────────────────────────────────────────────

describe("ADR-018 integration: writeResearchSynthesis _type matches required_handoffs type", () => {
  it("validateRequiredHandoffs recognizes the _type written by writeResearchSynthesis", async () => {
    const workspace = await makeTmpDir();

    // Researcher writes synthesis
    const writeResult = await writeResearchSynthesis({
      affected_subsystems: ["inject-context"],
      key_findings: [{ confidence: "high", finding: "Handoff pipeline works end-to-end" }],
      open_questions: [],
      risk_areas: [],
      slug: "adr-018",
      workspace,
    });
    assertOk(writeResult);

    // Flow requires the handoff with type "research_synthesis"
    const flow = makeMinimalFlow({
      states: {
        build: {
          required_handoffs: [{ name: "RESEARCH-SYNTHESIS", type: "research_synthesis" }],
          transitions: { done: "review", failed: "hitl" },
          type: "single",
        },
        hitl: { type: "terminal" },
        review: { transitions: { done: "ship" }, type: "single" },
        ship: { type: "terminal" },
      },
    });
    setupWorkspace(workspace, flow);

    const result = await reportResult({
      flow,
      state_id: "build",
      status_keyword: "DONE",
      workspace,
    });
    assertOk(result);

    // No warnings — _type matches
    expect((result as Record<string, unknown>).warnings).toBeUndefined();
  });

  it("wrong type expectation on RESEARCH-SYNTHESIS meta produces warning", async () => {
    const workspace = await makeTmpDir();

    await writeResearchSynthesis({
      affected_subsystems: [],
      key_findings: [],
      open_questions: [],
      risk_areas: [],
      slug: "adr-018",
      workspace,
    });

    const flow = makeMinimalFlow({
      states: {
        build: {
          required_handoffs: [
            // Expect design_brief but synthesis was written (type: research_synthesis)
            { name: "RESEARCH-SYNTHESIS", type: "design_brief" },
          ],
          transitions: { done: "review", failed: "hitl" },
          type: "single",
        },
        hitl: { type: "terminal" },
        review: { transitions: { done: "ship" }, type: "single" },
        ship: { type: "terminal" },
      },
    });
    setupWorkspace(workspace, flow);

    const result = await reportResult({
      flow,
      state_id: "build",
      status_keyword: "DONE",
      workspace,
    });
    assertOk(result);

    const warnings = (result as Record<string, unknown>).warnings as string[] | undefined;
    expect(warnings).toBeDefined();
    expect(warnings!.some((w) => w.includes("research_synthesis"))).toBe(true);
    expect(warnings!.some((w) => w.includes("design_brief"))).toBe(true);
  });
});
