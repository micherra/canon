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
