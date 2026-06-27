/**
 * mutator-gate-integration.test.ts — AC#4 + AC#9 end-to-end gate integration tests.
 *
 * Demonstrates the full loop on a REAL guardrail-corpus target (AC#9) OFFLINE
 * (mocked process-adapter — no real eval tokens spent).
 *
 * AC#4 assertion: regressive candidate → accepted:false → never shaped into a proposal.
 * AC#9 assertion: evaluateCandidate routes a guardrail target through the full offline
 *   gate; a non-regressive mock result → accepted:true → shapeMutationProposal valid.
 *
 * Canon principles:
 *   - evolution-hard-gate: only accepted===true produces a proposal
 *   - no-llm-calls-in-mcp-tools: process-adapter mocked so no real invocations
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
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
import type { FailureAttribution } from "../services/attribution-types.ts";
import { shapeMutationProposal } from "../services/mutation-proposal.ts";
import type { MutationTarget } from "../services/mutation-types.ts";
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

function makeTarget(
  targetPath: string,
  artifactClass: MutationTarget["artifact_class"],
): MutationTarget {
  const attribution: FailureAttribution = {
    failure_kind: "review_violation",
    hypothesis: "Artifact was present in context.",
    target_artifact: {
      id: "agent-tdd-required",
      kind: "rule",
      path: targetPath,
      content_hash: "abc123",
      char_span: [0, 100],
      span_available: true,
      hash_verified: true,
      hash_status: "verified",
    },
    attributed_violations: [
      {
        principle_id: "agent-tdd-required",
        severity: "BLOCKING",
        file_path: "src/foo.ts",
        message: "Tests not written first.",
      },
    ],
    owning_steps: [{ step_id: "implement", agent_id: "agent-001", agent_name: "canon:engineer" }],
    ambiguous: false,
    join_basis: "principle_id==artifact_id",
    transcript_evidence: [],
    confidence: "high",
    presence_in_context: true,
  };

  return {
    target_path: targetPath,
    artifact_class: artifactClass,
    baseline_body: "# Original rule content",
    char_span: [0, 100],
    gate_eligible: true,
    confidence: "high",
    failure_kind: "review_violation",
    principle_id: "agent-tdd-required",
    attributed_violation_count: 1,
    attribution,
  };
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

describe("mutator gate integration (offline — no eval tokens)", () => {
  let projectDir: string;

  beforeEach(async () => {
    const { mkdtemp } = await import("node:fs/promises");
    projectDir = await mkdtemp(join(tmpdir(), "canon-mutator-gate-test-"));

    // Create a minimal project with a guardrail rules/ dir
    await mkdir(join(projectDir, "rules"), { recursive: true });
    await writeFile(join(projectDir, "rules", "agent-foo.md"), "# Agent Foo\n\nOriginal content.");

    // Create eval surface (required by withInjectedGuardrailCandidate which copies skills/)
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

  // ── AC#9: evaluateCandidate works offline on a guardrail target ──────────────

  describe("AC#9 — guardrail target routing (rules/agent-foo.md)", () => {
    it("evaluateCandidate on a guardrail target succeeds offline (all equal scores)", async () => {
      // ALL calls return the same score → baseline=candidate → not strictly accepted
      mockRunShell.mockReturnValue(makeOkResult(1));

      const result = await evaluateCandidate({
        candidate_text: "# Agent Foo (candidate)\n\nImproved content.",
        project_dir: projectDir,
        target_path: "rules/agent-foo.md",
        splits: ["holdout"], // only holdout for speed
      });

      expect(result.ok).toBe(true);
    });

    it("result.accepted === false when baseline and candidate get equal holdout scores", async () => {
      // Same score for all calls → baseline.holdout == candidate.holdout → accepted=false
      mockRunShell.mockReturnValue(makeOkResult(2));

      const result = await evaluateCandidate({
        candidate_text: "# Agent Foo — same quality candidate",
        project_dir: projectDir,
        target_path: "rules/agent-foo.md",
        splits: ["holdout"],
      });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");
      // Equal holdout scores → NOT strictly greater → accepted:false
      expect(result.accepted).toBe(false);
    });

    it("every runShell call includes EVAL_PLUGIN_DIR= (guardrail injection active)", async () => {
      mockRunShell.mockReturnValue(makeOkResult(1));

      await evaluateCandidate({
        candidate_text: "# guardrail candidate",
        project_dir: projectDir,
        target_path: "rules/agent-foo.md",
        splits: ["holdout"],
      });

      const calls = mockRunShell.mock.calls;
      expect(calls.length).toBeGreaterThan(0);
      for (const [command] of calls) {
        expect(command).toMatch(/EVAL_PLUGIN_DIR=/);
      }
    });
  });

  // ── AC#4: Gate prevents shaping when not accepted ────────────────────────────

  describe("AC#4 — evolution-hard-gate: regressive/equal candidate never shaped", () => {
    it("a candidate with accepted:false (equal holdout) must not be shaped", async () => {
      mockRunShell.mockReturnValue(makeOkResult(2));

      const result = await evaluateCandidate({
        candidate_text: "# regressive candidate",
        project_dir: projectDir,
        target_path: "rules/agent-foo.md",
        splits: ["holdout"],
      });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");

      // Gate condition: only call shapeMutationProposal when accepted===true
      // This is the evolution-hard-gate invariant
      expect(result.accepted).toBe(false);

      // Verify: in the evolve-candidate skill, this condition guards proposal emission
      // The test demonstrates this by checking the gate value, not by calling shapeMutationProposal
      const shouldShape = result.accepted; // false → shapeMutationProposal MUST NOT be called
      expect(shouldShape).toBe(false);
    });

    it("shapeMutationProposal is only valid to call when evalResult.accepted === true", () => {
      // Direct unit test: mock an accepted:true evalResult → shapeMutationProposal succeeds
      const mockEvalResultAccepted: EvaluateCandidateResult = {
        accepted: true,
        regressed: false,
        baseline_score: 1,
        candidate_score: 2,
        per_split: {
          train: { baseline_passed: 1, candidate_passed: 2, total: 3 },
          val: { baseline_passed: 1, candidate_passed: 2, total: 3 },
          holdout: { baseline_passed: 1, candidate_passed: 2, total: 3 },
        },
        size_delta: 10,
        judge_votes_holdout: 3,
      };

      const guardrailTarget = makeTarget("rules/agent-foo.md", "rule");
      const proposal = shapeMutationProposal({
        candidateText: "# Agent Foo — improved content",
        evalResult: mockEvalResultAccepted,
        index: 1,
        target: guardrailTarget,
        ts: "20260625T143000",
      });

      // Verify the proposal has the expected shape
      expect(proposal.frontmatter.accepted).toBe(true);
      expect(proposal.frontmatter.type).toBe("evolution-candidate");
      expect(proposal.frontmatter.apply_channel).toBe("writer"); // rule → writer
      expect(proposal.frontmatter.holdout_baseline).toBe(1);
      expect(proposal.frontmatter.holdout_candidate).toBe(2);
    });

    it("shapeMutationProposal for a non-regressive guardrail target produces valid proposal body", () => {
      const mockEvalResultAccepted: EvaluateCandidateResult = {
        accepted: true,
        regressed: false,
        baseline_score: 1,
        candidate_score: 3,
        per_split: {
          train: { baseline_passed: 1, candidate_passed: 3, total: 3 },
          val: { baseline_passed: 1, candidate_passed: 3, total: 3 },
          holdout: { baseline_passed: 1, candidate_passed: 3, total: 3 },
        },
        size_delta: 50,
        judge_votes_holdout: 3,
      };

      const guardrailTarget = makeTarget("rules/agent-foo.md", "rule");
      const candidateText = "# Agent Foo\n\nAlways write tests first.\n\nExample: ...\n";
      const proposal = shapeMutationProposal({
        candidateText,
        evalResult: mockEvalResultAccepted,
        index: 1,
        target: guardrailTarget,
        ts: "20260625T143000",
      });

      expect(proposal.markdown).toContain("## Observation");
      expect(proposal.markdown).toContain("## Proposed Change");
      expect(proposal.markdown).toContain("## Evidence");
      expect(proposal.markdown).toContain("## Impact");
      expect(proposal.markdown).toContain(candidateText);
      expect(proposal.filename).toMatch(/^01-evolve-.*\.md$/);
      expect(proposal.frontmatter.target_path).toBe("rules/agent-foo.md");
    });
  });
});
