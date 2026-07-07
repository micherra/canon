/**
 * evaluate-candidate-holistic-gate.test.ts — mandatory holistic verdict gate
 * (holistic-gate, G4, watch_VVVVV2 / PR #332).
 *
 * Split out of evaluate-candidate.test.ts (biome noExcessiveLinesPerFile) — covers the
 * evaluate_candidate handler's composite gate wiring: dual-suite dispatch (per-stage +
 * holistic), the non-regression veto, absent-suite backward compatibility, and fail-closed
 * behavior on a holistic-side subprocess error.
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import type { ProcessResult } from "@shared/lib/tool-result.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// We mock the process-adapter before importing the handler
vi.mock("@platform/adapters/process-adapter.ts", () => ({
  runShell: vi.fn(),
}));

import { runShell } from "@platform/adapters/process-adapter.ts";
import { evaluateCandidate } from "../tools/evaluate-candidate.ts";

const mockRunShell = vi.mocked(runShell);

const SPLIT_SUMMARIES = {
  holdout_baseline: "Total: 3 | Passed: 2 | Failed: 1 | Errors: 0 | Skipped: 0",
  holdout_candidate: "Total: 3 | Passed: 3 | Failed: 0 | Errors: 0 | Skipped: 0",
};

function makeOkResult(stdout: string): ProcessResult {
  return { duration_ms: 100, exitCode: 0, ok: true, stderr: "", stdout, timedOut: false };
}

function makeErrorResult(stderr: string): ProcessResult {
  return { duration_ms: 100, exitCode: 1, ok: false, stderr, stdout: "", timedOut: false };
}

/** Whether a command includes a given flag. */
function hasFlag(command: string, flag: string): boolean {
  return command.includes(flag);
}

describe("holistic gate composite (holistic-gate)", () => {
  let projectDir: string;

  const AGENT_FRONTMATTER = "---\nname: reviewer\n---\n";

  beforeEach(async () => {
    const { mkdtemp } = await import("node:fs/promises");
    projectDir = await mkdtemp(join(tmpdir(), "canon-eval-holistic-test-"));
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await rm(projectDir, { force: true, recursive: true });
  });

  /** Seed a reviewer agent-def with a per-stage suite AND (optionally) a holistic sub-suite. */
  async function seedReviewerSuite(withHolistic: boolean): Promise<void> {
    await mkdir(join(projectDir, "agents", "reviewer", "evals"), { recursive: true });
    await writeFile(
      join(projectDir, "agents", "reviewer", "evals", "run-agent-evals.sh"),
      "#!/bin/bash\necho test",
    );
    await writeFile(join(projectDir, "agents", "reviewer.md"), `${AGENT_FRONTMATTER}baseline body`);
    if (withHolistic) {
      await mkdir(join(projectDir, "agents", "reviewer", "evals", "holistic"), { recursive: true });
      await writeFile(
        join(projectDir, "agents", "reviewer", "evals", "holistic", "eval-set.json"),
        '{"agent":"reviewer","evals":[]}',
      );
    }
  }

  /** True iff the command's --eval-root value points at the holistic subdir. */
  function isHolisticCommand(command: string): boolean {
    return command.includes("--eval-root") && command.includes(`${sep}holistic`);
  }

  it("holistic present, non-regressed → composite accepts a per-stage improvement", async () => {
    await seedReviewerSuite(true);

    let holisticCallCount = 0;
    let perStageCallCount = 0;
    mockRunShell.mockImplementation((command: string) => {
      if (hasFlag(command, "--dry-run")) {
        return makeOkResult(SPLIT_SUMMARIES.holdout_baseline);
      }
      if (isHolisticCommand(command)) {
        holisticCallCount++;
        // Holistic tie: 2/3 both sides (non-regression satisfied, not itself an improvement)
        return makeOkResult(SPLIT_SUMMARIES.holdout_baseline);
      }
      if (hasFlag(command, "--split holdout")) {
        perStageCallCount++;
        // Per-stage +1: baseline 2/3, candidate 3/3
        return perStageCallCount === 1
          ? makeOkResult(SPLIT_SUMMARIES.holdout_baseline)
          : makeOkResult(SPLIT_SUMMARIES.holdout_candidate);
      }
      return makeOkResult(SPLIT_SUMMARIES.holdout_baseline);
    });

    const result = await evaluateCandidate({
      candidate_text: `${AGENT_FRONTMATTER}candidate body`,
      project_dir: projectDir,
      splits: ["holdout"],
      target_path: "agents/reviewer.md",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(holisticCallCount).toBeGreaterThan(0);
    expect(result.holistic).toBeDefined();
    // Per-stage improved (2->3) and holistic tied (2->2, non-regression) → accepted
    const isPerStageUp = result.candidate_score > result.baseline_score;
    expect(result.accepted).toBe(isPerStageUp);
  });

  it("holistic regresses → vetoes acceptance even when per-stage improves (VETO)", async () => {
    await seedReviewerSuite(true);

    let perStageCallCount = 0;
    let holisticCallCount = 0;
    mockRunShell.mockImplementation((command: string) => {
      if (hasFlag(command, "--dry-run")) {
        return makeOkResult(SPLIT_SUMMARIES.holdout_baseline);
      }
      if (isHolisticCommand(command)) {
        holisticCallCount++;
        // Holistic regresses: baseline 3/3, candidate 2/3
        return holisticCallCount === 1
          ? makeOkResult(SPLIT_SUMMARIES.holdout_candidate) // 3 passed (baseline)
          : makeOkResult(SPLIT_SUMMARIES.holdout_baseline); // 2 passed (candidate)
      }
      if (hasFlag(command, "--split holdout")) {
        perStageCallCount++;
        // Per-stage improves: baseline 2/3, candidate 3/3
        return perStageCallCount === 1
          ? makeOkResult(SPLIT_SUMMARIES.holdout_baseline)
          : makeOkResult(SPLIT_SUMMARIES.holdout_candidate);
      }
      return makeOkResult(SPLIT_SUMMARIES.holdout_baseline);
    });

    const result = await evaluateCandidate({
      candidate_text: `${AGENT_FRONTMATTER}candidate body`,
      project_dir: projectDir,
      splits: ["holdout"],
      target_path: "agents/reviewer.md",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Composite is stricter than per-stage alone: holistic regression vetoes the accept.
    expect(result.accepted).toBe(false);
    expect(result.regressed).toBe(true);
  });

  it("holistic suite absent → no holistic field, composite equals per-stage-only decision", async () => {
    await seedReviewerSuite(false);

    mockRunShell.mockImplementation((command: string) => {
      if (hasFlag(command, "--dry-run")) {
        return makeOkResult(SPLIT_SUMMARIES.holdout_baseline);
      }
      return makeOkResult(SPLIT_SUMMARIES.holdout_candidate);
    });

    const result = await evaluateCandidate({
      candidate_text: `${AGENT_FRONTMATTER}candidate body`,
      project_dir: projectDir,
      splits: ["holdout"],
      target_path: "agents/reviewer.md",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.holistic).toBeUndefined();

    const commands = mockRunShell.mock.calls.map((call) => call[0] as string);
    expect(commands.some((c) => isHolisticCommand(c))).toBe(false);
  });

  it("fail-closed: a subprocess error on the holistic run returns a ToolResult error", async () => {
    await seedReviewerSuite(true);

    mockRunShell.mockImplementation((command: string) => {
      if (hasFlag(command, "--dry-run")) {
        return makeOkResult(SPLIT_SUMMARIES.holdout_baseline);
      }
      if (isHolisticCommand(command)) {
        // Genuine infra failure on the holistic run — no parseable summary.
        return makeErrorResult("Unexpected error: segfault");
      }
      // Per-stage run succeeds normally.
      return makeOkResult(SPLIT_SUMMARIES.holdout_candidate);
    });

    const result = await evaluateCandidate({
      candidate_text: `${AGENT_FRONTMATTER}candidate body`,
      project_dir: projectDir,
      splits: ["holdout"],
      target_path: "agents/reviewer.md",
    });

    // Must fail closed — a holistic-side subprocess error is never an accept.
    expect(result.ok).toBe(false);
  });
});
