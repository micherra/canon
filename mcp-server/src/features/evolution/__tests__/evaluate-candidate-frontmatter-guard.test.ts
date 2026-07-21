/**
 * evaluate-candidate-frontmatter-guard.test.ts — TASK-003 handler wiring (dc-08).
 *
 * Verifies evaluate_candidate REJECTS, before any eval subprocess, an agent-def candidate
 * whose frontmatter block differs from baseline. Mirrors the offline pattern of
 * guardrail-injection-integration.test.ts: @platform/adapters/process-adapter is mocked so
 * no real claude invocations happen.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProcessResult } from "@shared/lib/tool-result.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@platform/adapters/process-adapter.ts", () => ({
  runShell: vi.fn(),
}));

import { runShell } from "@platform/adapters/process-adapter.ts";
import { evaluateCandidate } from "../tools/evaluate-candidate.ts";

const mockRunShell = vi.mocked(runShell);

function makeOkResult(
  stdout = "Total: 1 | Passed: 1 | Failed: 0 | Errors: 0 | Skipped: 0",
): ProcessResult {
  return { duration_ms: 1, exitCode: 0, ok: true, stderr: "", stdout, timedOut: false };
}

const BASELINE_AGENT_DEF =
  "---\nname: engineer\ntools: [Read, Write]\nmodel: sonnet\n---\n\n# Role\n\nWrite code.\n";

describe("evaluateCandidate frontmatter-reject guard (TASK-003, dc-08)", () => {
  let projectDir: string;

  beforeEach(async () => {
    const { mkdtemp } = await import("node:fs/promises");
    projectDir = await mkdtemp(join(tmpdir(), "canon-fm-guard-test-"));
    await mkdir(join(projectDir, "skills", "canon", "evals"), { recursive: true });
    await writeFile(
      join(projectDir, "skills", "canon", "evals", "run-evals.sh"),
      "#!/bin/bash\necho test",
    );
    await mkdir(join(projectDir, "agents"), { recursive: true });
    await writeFile(join(projectDir, "agents", "engineer.md"), BASELINE_AGENT_DEF);

    vi.clearAllMocks();
    mockRunShell.mockReturnValue(makeOkResult());
  });

  afterEach(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(projectDir, { recursive: true, force: true });
  });

  it("rejects an agent-def candidate with an edited tools: line, no subprocess run", async () => {
    const candidate =
      "---\nname: engineer\ntools: [Read]\nmodel: sonnet\n---\n\n# Role\n\nWrite code.\n";

    const result = await evaluateCandidate({
      candidate_text: candidate,
      project_dir: projectDir,
      target_path: "agents/engineer.md",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.accepted).toBe(false);
    expect(result.regressed).toBe(false);
    expect(result.guard_rejection?.reason).toBe("frontmatter_modified");
    // No eval subprocess ran — the guard short-circuits before runAllSplits/checkScriptReachable.
    expect(mockRunShell).not.toHaveBeenCalled();
  });

  it("rejects with frontmatter_unverifiable for unparseable candidate YAML, no subprocess run", async () => {
    const candidate = "---\n[unclosed: [nested\n---\n\n# Role\n\nWrite code.\n";

    const result = await evaluateCandidate({
      candidate_text: candidate,
      project_dir: projectDir,
      target_path: "agents/engineer.md",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.guard_rejection?.reason).toBe("frontmatter_unverifiable");
    expect(mockRunShell).not.toHaveBeenCalled();
  });

  it("allows a body-only agent-def candidate to proceed to scoring (existing path)", async () => {
    const candidate =
      "---\nname: engineer\ntools: [Read, Write]\nmodel: sonnet\n---\n\n# Role\n\nWrite BETTER code.\n";

    const result = await evaluateCandidate({
      candidate_text: candidate,
      project_dir: projectDir,
      target_path: "agents/engineer.md",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.guard_rejection).toBeUndefined();
    expect(mockRunShell).toHaveBeenCalled();
  });

  it("skips the guard for a non-agent-def target (unchanged behavior)", async () => {
    await mkdir(join(projectDir, "rules"), { recursive: true });
    await writeFile(join(projectDir, "rules", "placeholder.md"), "# placeholder");

    const result = await evaluateCandidate({
      candidate_text: "# edited rule text",
      project_dir: projectDir,
      target_path: "rules/placeholder.md",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.guard_rejection).toBeUndefined();
    expect(mockRunShell).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Overlay fail-closed reject (dc-02, dc-06 — ADR-0027 sandbox exclusion)
// ---------------------------------------------------------------------------

const BASELINE_PRINCIPLE =
  "---\nid: some-principle\nseverity: convention\n---\n\n# Some Principle\n\nOriginal body.\n";

describe("evaluateCandidate overlay fail-closed reject (dc-02, dc-06)", () => {
  let projectDir: string;

  beforeEach(async () => {
    const { mkdtemp } = await import("node:fs/promises");
    projectDir = await mkdtemp(join(tmpdir(), "canon-overlay-guard-test-"));
    await mkdir(join(projectDir, "skills", "canon", "evals"), { recursive: true });
    await writeFile(
      join(projectDir, "skills", "canon", "evals", "run-evals.sh"),
      "#!/bin/bash\necho test",
    );
    await mkdir(join(projectDir, "principles", "conventions"), { recursive: true });
    await writeFile(
      join(projectDir, "principles", "conventions", "some-principle.md"),
      BASELINE_PRINCIPLE,
    );
    await mkdir(join(projectDir, ".canon", "principles", "rules"), { recursive: true });
    await writeFile(join(projectDir, ".canon", "principles", "rules", "x.md"), BASELINE_PRINCIPLE);

    vi.clearAllMocks();
    mockRunShell.mockReturnValue(makeOkResult());
  });

  afterEach(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(projectDir, { recursive: true, force: true });
  });

  it("a .canon/principles/rules/x.md target is rejected fail-closed, zero runShell calls", async () => {
    const result = await evaluateCandidate({
      candidate_text: "# edited overlay principle body",
      project_dir: projectDir,
      target_path: ".canon/principles/rules/x.md",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.accepted).toBe(false);
    expect(result.guard_rejection?.reason).toBe("overlay_not_sandboxable");
    expect(mockRunShell).not.toHaveBeenCalled();
  });

  it("any .canon/** target (not just principles) is rejected fail-closed, zero runShell calls", async () => {
    await mkdir(join(projectDir, ".canon", "kg-languages"), { recursive: true });
    await writeFile(join(projectDir, ".canon", "kg-languages", "x.json"), "{}");

    const result = await evaluateCandidate({
      candidate_text: "{}",
      project_dir: projectDir,
      target_path: ".canon/kg-languages/x.json",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.guard_rejection?.reason).toBe("overlay_not_sandboxable");
    expect(mockRunShell).not.toHaveBeenCalled();
  });

  it("a case-varied .CANON/** target is rejected fail-closed the same as lowercase .canon", async () => {
    const result = await evaluateCandidate({
      candidate_text: "# edited overlay principle body",
      project_dir: projectDir,
      target_path: ".CANON/principles/rules/x.md",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.accepted).toBe(false);
    expect(result.guard_rejection?.reason).toBe("overlay_not_sandboxable");
    expect(mockRunShell).not.toHaveBeenCalled();
  });

  it("a mixed-case .Canon/** target is rejected fail-closed the same as lowercase .canon", async () => {
    const result = await evaluateCandidate({
      candidate_text: "# edited overlay principle body",
      project_dir: projectDir,
      target_path: ".Canon/principles/rules/x.md",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.accepted).toBe(false);
    expect(result.guard_rejection?.reason).toBe("overlay_not_sandboxable");
    expect(mockRunShell).not.toHaveBeenCalled();
  });

  it("a built-in principles/ target with a MUTATED frontmatter block is rejected (frontmatter_modified)", async () => {
    const candidate =
      "---\nid: some-principle\nseverity: rule\n---\n\n# Some Principle\n\nOriginal body.\n";

    const result = await evaluateCandidate({
      candidate_text: candidate,
      project_dir: projectDir,
      target_path: "principles/conventions/some-principle.md",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.guard_rejection?.reason).toBe("frontmatter_modified");
    expect(mockRunShell).not.toHaveBeenCalled();
  });

  it("a body-only built-in principles/ candidate proceeds to scoring", async () => {
    const candidate =
      "---\nid: some-principle\nseverity: convention\n---\n\n# Some Principle\n\nBETTER body.\n";

    const result = await evaluateCandidate({
      candidate_text: candidate,
      project_dir: projectDir,
      target_path: "principles/conventions/some-principle.md",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.guard_rejection).toBeUndefined();
    expect(mockRunShell).toHaveBeenCalled();
  });

  it("a REWRITE candidate (no proposal_kind) that flips archived:true is REJECTED — gate-vs-apply soundness fix", async () => {
    const candidate =
      "---\nid: some-principle\nseverity: convention\narchived: true\n---\n\n# Some Principle\n\nOriginal body.\n";

    const result = await evaluateCandidate({
      candidate_text: candidate,
      project_dir: projectDir,
      target_path: "principles/conventions/some-principle.md",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    // Missing proposal_kind is fail-closed treated as "rewrite" — the archived exception
    // is RETIRE-ONLY. A wording-rewrite candidate that flips archived is a frontmatter
    // mutation, which the rewrite contract forbids.
    expect(result.guard_rejection?.reason).toBe("frontmatter_modified");
    expect(result.guard_rejection?.fields).toContain("archived");
    expect(mockRunShell).not.toHaveBeenCalled();
  });

  it("a principles/ RETIRE candidate (proposal_kind: 'retire') that adds archived:true proceeds to scoring (ADR-0052 retire exception)", async () => {
    const candidate =
      "---\nid: some-principle\nseverity: convention\narchived: true\n---\n\n# Some Principle\n\nOriginal body.\n";

    const result = await evaluateCandidate({
      candidate_text: candidate,
      project_dir: projectDir,
      proposal_kind: "retire",
      target_path: "principles/conventions/some-principle.md",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.guard_rejection).toBeUndefined();
    expect(mockRunShell).toHaveBeenCalled();
  });

  it("a principles/ REINFORCE candidate (proposal_kind: 'reinforce') that flips archived:true is REJECTED — only 'retire' tolerates archived", async () => {
    const candidate =
      "---\nid: some-principle\nseverity: convention\narchived: true\n---\n\n# Some Principle\n\nOriginal body.\n";

    const result = await evaluateCandidate({
      candidate_text: candidate,
      project_dir: projectDir,
      proposal_kind: "reinforce",
      target_path: "principles/conventions/some-principle.md",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.guard_rejection?.reason).toBe("frontmatter_modified");
    expect(mockRunShell).not.toHaveBeenCalled();
  });
});
