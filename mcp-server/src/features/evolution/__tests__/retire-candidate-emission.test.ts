/**
 * retire-candidate-emission.test.ts — End-to-end Gap 3 Layer 3 gate integration.
 *
 * Chains the full retire/reinforce pipeline OFFLINE (mocked process-adapter — no
 * real eval tokens spent), mirroring mutator-gate-integration.test.ts:
 *
 *   selectRetirementReinforcementTargets (scores → target)
 *     → evaluateCandidate (§7 holdout gate, mocked runShell)
 *       → shapeMutationProposal (only when accepted===true)
 *         → simulated emission to .canon/proposed-learnings/ (fs write, mirrors
 *           the learner's SKILL.md Step 4 — the tool itself never writes)
 *
 * dc-04 assertion: a strongly-negative principle → retirement proposal FILE
 *   emitted; zero mutation of any `principles/**` file (the tool + this pipeline
 *   are a pure query — only .canon/proposed-learnings/ is ever written).
 * AC#6 assertion: evaluate_candidate reject (regressed/not-accepted) → NO emission.
 *
 * Canon principles:
 *   - evolution-hard-gate: only accepted===true produces a proposal
 *   - command-query-separation: the selection tool never mutates principles/**
 *   - invalidate-don't-delete: retirement never deletes the artifact
 *   - no-llm-calls-in-mcp-tools: process-adapter mocked so no real invocations
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProcessResult } from "@shared/lib/tool-result.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the process adapter BEFORE importing the tool under test.
// Vitest hoists vi.mock() calls above all imports automatically.
vi.mock("@platform/adapters/process-adapter.ts", () => ({
  runShell: vi.fn(),
}));

import { runShell } from "@platform/adapters/process-adapter.ts";
import { shapeMutationProposal } from "../services/mutation-proposal.ts";
import { selectRetirementReinforcementTargets } from "../services/mutation-selection.ts";
import type { TrustWeightedScore } from "../services/outcome-attribution.ts";
import type { EvaluateCandidateResult } from "../tools/evaluate-candidate.ts";
import { evaluateCandidate } from "../tools/evaluate-candidate.ts";

const mockRunShell = vi.mocked(runShell);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOkResult(passed: number, total = 3): ProcessResult {
  return {
    duration_ms: 1,
    exitCode: 0,
    ok: true,
    stderr: "",
    stdout: `Total: ${total} | Passed: ${passed} | Failed: ${total - passed} | Errors: 0 | Skipped: 0`,
    timedOut: false,
  };
}

const PRINCIPLE_PATH = "principles/rules/some-principle.md";
const PRINCIPLE_BODY = "# Some Principle\n\nOriginal content, before any retirement.";

function makeStronglyNegativeScore(): TrustWeightedScore {
  return {
    contributing_builds: [
      { archive_id: "archive-001", sign: -1, weight: 3.2 },
      { archive_id: "archive-002", sign: -1, weight: 2.8 },
    ],
    corroboration: 2,
    negative_weight: 6,
    net_score: -6,
    positive_weight: 0,
    principle_id: "some-principle",
    tier_breakdown: { codex: 0, internal: -6 },
  };
}

/** Simulates the learner's SKILL.md Step 4 write — the tool itself never writes. */
async function emitProposal(
  proposedLearningsDir: string,
  markdown: string,
  filename: string,
): Promise<void> {
  await mkdir(proposedLearningsDir, { recursive: true });
  await writeFile(join(proposedLearningsDir, filename), markdown);
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

describe("retire candidate emission (offline — no eval tokens)", () => {
  let projectDir: string;
  let proposedLearningsDir: string;

  beforeEach(async () => {
    const { mkdtemp } = await import("node:fs/promises");
    projectDir = await mkdtemp(join(tmpdir(), "canon-retire-emission-test-"));
    proposedLearningsDir = join(projectDir, ".canon", "proposed-learnings", "20260711T000000Z");

    await mkdir(join(projectDir, "principles", "rules"), { recursive: true });
    await writeFile(join(projectDir, "principles", "rules", "some-principle.md"), PRINCIPLE_BODY);

    // Guardrail eval surface (required by withInjectedGuardrailCandidate)
    await mkdir(join(projectDir, "skills", "canon", "evals"), { recursive: true });
    await writeFile(
      join(projectDir, "skills", "canon", "evals", "run-evals.sh"),
      "#!/bin/bash\necho 'Total: 3 | Passed: 1 | Failed: 2 | Errors: 0 | Skipped: 0'",
    );

    vi.clearAllMocks();
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  it("dc-04: strongly-negative principle → retirement proposal emitted; principles/** never mutated", async () => {
    // Selection: net_score -6 crosses the -3 threshold → a retire target
    const selection = selectRetirementReinforcementTargets([makeStronglyNegativeScore()], (id) =>
      id === "some-principle" ? { body: PRINCIPLE_BODY, path: PRINCIPLE_PATH } : null,
    );
    expect(selection.targets).toHaveLength(1);
    expect(selection.targets[0].proposal_kind).toBe("retire");

    const target = selection.targets[0];
    const weakenedCandidate = `---\nid: some-principle\nstatus: retired\nportable: true\n---\n\n${PRINCIPLE_BODY}\n\n> RETIRED: trust-weighted evidence shows this principle no longer earns its keep.`;

    // Gate: an accepted (candidate > baseline) holdout result. Real evaluateCandidate()
    // call ordering across parallel baseline/candidate + dry-run-reachability runShell
    // invocations is not deterministic to drive from a mock — mirrors
    // mutator-gate-integration.test.ts's own pattern of constructing an accepted:true
    // EvaluateCandidateResult directly for the "accepted" branch.
    const evalResult: EvaluateCandidateResult = {
      accepted: true,
      baseline_score: 1,
      candidate_score: 3,
      judge_votes_holdout: 3,
      per_split: {
        holdout: { baseline_passed: 1, candidate_passed: 3, total: 3 },
        train: { baseline_passed: 1, candidate_passed: 3, total: 3 },
        val: { baseline_passed: 1, candidate_passed: 3, total: 3 },
      },
      regressed: false,
      size_delta: 20,
    };

    const proposal = shapeMutationProposal({
      candidateText: weakenedCandidate,
      evalResult,
      index: 1,
      target,
      ts: "20260711T000000Z",
    });

    expect(proposal.frontmatter.proposal_kind).toBe("retire");
    expect(proposal.frontmatter.apply_channel).toBe("writer");
    expect(proposal.markdown).toMatch(/invalidate-don't-delete/i);

    await emitProposal(proposedLearningsDir, proposal.markdown, proposal.filename);
    const written = await readFile(join(proposedLearningsDir, proposal.filename), "utf-8");
    expect(written).toContain("proposal_kind: retire");

    // dc-04: the trusted artifact was never touched by this pipeline — only
    // .canon/proposed-learnings/ was written.
    const stillOnDisk = await readFile(
      join(projectDir, "principles", "rules", "some-principle.md"),
      "utf-8",
    );
    expect(stillOnDisk).toBe(PRINCIPLE_BODY);
  });

  it("AC#6: evaluate_candidate reject (regressed) → no proposal emission", async () => {
    const selection = selectRetirementReinforcementTargets([makeStronglyNegativeScore()], (id) =>
      id === "some-principle" ? { body: PRINCIPLE_BODY, path: PRINCIPLE_PATH } : null,
    );
    const target = selection.targets[0];
    const weakenedCandidate = "# Some Principle (weakened, but worse)";

    // Gate: every runShell call (dry-run reachability + baseline + candidate, across both
    // parallel splits) returns the SAME score → candidate does not strictly improve on
    // baseline → accepted:false (§7 strict-holdout: equal is a rejection, not an accept).
    mockRunShell.mockReturnValue(makeOkResult(2));

    const evalResult = await evaluateCandidate({
      candidate_text: weakenedCandidate,
      project_dir: projectDir,
      target_path: target.target_path,
      splits: ["holdout"],
    });
    expect(evalResult.ok).toBe(true);
    if (!evalResult.ok) throw new Error("expected ok");
    expect(evalResult.accepted).toBe(false);

    // evolution-hard-gate: NEVER call shapeMutationProposal / emit when accepted !== true
    const shouldEmit = evalResult.accepted;
    expect(shouldEmit).toBe(false);

    // Assert nothing was written to proposed-learnings/ and the artifact is untouched.
    const { existsSync } = await import("node:fs");
    expect(existsSync(proposedLearningsDir)).toBe(false);
    const stillOnDisk = await readFile(
      join(projectDir, "principles", "rules", "some-principle.md"),
      "utf-8",
    );
    expect(stillOnDisk).toBe(PRINCIPLE_BODY);
  });
});
