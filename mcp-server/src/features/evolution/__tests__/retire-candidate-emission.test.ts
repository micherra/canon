/**
 * retire-candidate-emission.test.ts — End-to-end Gap 3 Layer 3 gate integration.
 *
 * Chains the full retire/reinforce pipeline OFFLINE (mocked process-adapter — no
 * real eval tokens spent), mirroring mutator-gate-integration.test.ts:
 *
 *   selectRetirementReinforcementTargets (scores → target)
 *     → evaluateCandidate (§7 holdout gate, mocked runShell) — RETIRE ONLY
 *       → shapeMutationProposal (only when accepted===true)
 *         → simulated emission to .canon/proposed-learnings/ (fs write, mirrors
 *           the learner's SKILL.md Step 4 — the tool itself never writes)
 *
 * REAL-GATE FIX (Gap 3 review, Finding 1 BLOCKING): the previous version of this
 * suite proved dc-04 by hand-forging an `accepted: true` EvaluateCandidateResult,
 * which never actually drove evaluateCandidate()'s subprocess-dispatch gate. That
 * was masking a structurally inert pipeline: a `retire` candidate built from
 * `status: retired` / `portable: false` frontmatter is NOT loader-honored
 * (`shared/matcher.ts:126` only excludes `archived === true`), so the candidate
 * sandbox always scored identically to baseline and `decideGate`'s strict `>`
 * always rejected — no candidate could ever be accepted for real.
 *
 * The tests below call the REAL evaluateCandidate() (mocked only at the runShell
 * subprocess boundary) with a candidate that sets `archived: true` — the
 * loader-honored flag — and drive mockRunShell's return value FROM THE ACTUAL
 * INJECTED FILE CONTENT inside each sandbox (baseline vs. candidate get distinct
 * temp dirs — see candidate-injection.ts), so the gate's accept/reject decision is
 * genuinely derived from what evaluateCandidate() wrote to disk, not asserted by
 * the test.
 *
 * dc-04 assertion: an archived:true retire candidate that strictly improves the
 *   (mocked) holdout → retirement proposal FILE emitted via the REAL gate; zero
 *   mutation of any `principles/**` file.
 * AC#6 assertion: an archived:true retire candidate that REGRESSES the (mocked)
 *   holdout → REAL gate rejects → NO emission.
 * reinforce assertion: a reinforce target is NEVER run through evaluateCandidate
 *   (Gap 3 L3 fix) — shapeMutationProposal is called directly with evalResult:null
 *   and the emitted proposal is `gated:false` with null holdout fields.
 *
 * Canon principles:
 *   - evolution-hard-gate: only accepted===true produces a retire proposal
 *   - command-query-separation: the selection tool never mutates principles/**
 *   - invalidate-don't-delete: retirement never deletes the artifact
 *   - no-llm-calls-in-mcp-tools: process-adapter mocked so no real invocations
 */

import { readFileSync } from "node:fs";
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

/** The candidate the SKILL.md Step 0.3 procedure now produces: archived:true (loader-honored). */
const ARCHIVED_CANDIDATE = `---\nid: some-principle\narchived: true\n---\n\n${PRINCIPLE_BODY}\n\n> RETIRED: trust-weighted evidence shows this principle no longer earns its keep.`;

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

function makeStronglyPositiveScore(): TrustWeightedScore {
  return {
    contributing_builds: [{ archive_id: "archive-003", sign: 1, weight: 3.5 }],
    corroboration: 1,
    negative_weight: 0,
    net_score: 6,
    positive_weight: 6,
    principle_id: "some-principle",
    tier_breakdown: { codex: 0, internal: 6 },
  };
}

/** Simulates the learner's SKILL.md Step 0.5/4 write — the tool itself never writes. */
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

describe("retire candidate emission (offline — no eval tokens, drives the REAL gate)", () => {
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

  it("dc-04 (REAL gate): archived:true candidate that strictly improves the holdout → retirement proposal emitted; principles/** never mutated", async () => {
    // Selection: net_score -6 crosses the -3 threshold → a retire target
    const selection = selectRetirementReinforcementTargets([makeStronglyNegativeScore()], (id) =>
      id === "some-principle" ? { body: PRINCIPLE_BODY, path: PRINCIPLE_PATH } : null,
    );
    expect(selection.targets).toHaveLength(1);
    expect(selection.targets[0].proposal_kind).toBe("retire");
    const target = selection.targets[0];

    // Drive the mock FROM the actual sandbox content evaluateCandidate() wrote to
    // disk: baseline (not archived) scores lower, the archived:true candidate
    // scores higher — the accept decision is genuinely derived, not asserted.
    mockRunShell.mockImplementation((command: string, cwd: string) => {
      if (command.includes("--dry-run")) return makeOkResult(0);
      const injected = readFileSync(join(cwd, target.target_path), "utf-8");
      return injected.includes("archived: true") ? makeOkResult(3) : makeOkResult(1);
    });

    const evalResult = await evaluateCandidate({
      candidate_text: ARCHIVED_CANDIDATE,
      project_dir: projectDir,
      target_path: target.target_path,
      splits: ["holdout"],
    });
    expect(evalResult.ok).toBe(true);
    if (!evalResult.ok) throw new Error("expected ok");
    // REAL gate, not hand-forged: archived candidate (3 passed) > baseline (1 passed).
    expect(evalResult.baseline_score).toBe(1);
    expect(evalResult.candidate_score).toBe(3);
    expect(evalResult.accepted).toBe(true);

    const proposal = shapeMutationProposal({
      candidateText: ARCHIVED_CANDIDATE,
      evalResult,
      index: 1,
      target,
      ts: "20260711T000000Z",
    });

    expect(proposal.frontmatter.proposal_kind).toBe("retire");
    expect(proposal.frontmatter.gated).toBe(true);
    expect(proposal.frontmatter.holdout_baseline).toBe(1);
    expect(proposal.frontmatter.holdout_candidate).toBe(3);
    expect(proposal.frontmatter.apply_channel).toBe("writer");
    expect(proposal.markdown).toMatch(/invalidate-don't-delete/i);
    expect(proposal.markdown).toMatch(/archived: true/);

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

  it("AC#6 (REAL gate): archived:true candidate that REGRESSES the holdout → no proposal emission", async () => {
    const selection = selectRetirementReinforcementTargets([makeStronglyNegativeScore()], (id) =>
      id === "some-principle" ? { body: PRINCIPLE_BODY, path: PRINCIPLE_PATH } : null,
    );
    const target = selection.targets[0];

    // Same archived:true candidate as the accept case above, but the mock now scores
    // the archived sandbox WORSE than baseline — proves the gate genuinely follows
    // the (mocked) eval outcome rather than accepting on `archived: true` alone.
    mockRunShell.mockImplementation((command: string, cwd: string) => {
      if (command.includes("--dry-run")) return makeOkResult(0);
      const injected = readFileSync(join(cwd, target.target_path), "utf-8");
      return injected.includes("archived: true") ? makeOkResult(1) : makeOkResult(3);
    });

    const evalResult = await evaluateCandidate({
      candidate_text: ARCHIVED_CANDIDATE,
      project_dir: projectDir,
      target_path: target.target_path,
      splits: ["holdout"],
    });
    expect(evalResult.ok).toBe(true);
    if (!evalResult.ok) throw new Error("expected ok");
    expect(evalResult.baseline_score).toBe(3);
    expect(evalResult.candidate_score).toBe(1);
    expect(evalResult.accepted).toBe(false);
    expect(evalResult.regressed).toBe(true);

    // evolution-hard-gate: NEVER call shapeMutationProposal / emit when accepted !== true
    expect(evalResult.accepted).toBe(false);

    // Assert nothing was written to proposed-learnings/ and the artifact is untouched.
    const { existsSync } = await import("node:fs");
    expect(existsSync(proposedLearningsDir)).toBe(false);
    const stillOnDisk = await readFile(
      join(projectDir, "principles", "rules", "some-principle.md"),
      "utf-8",
    );
    expect(stillOnDisk).toBe(PRINCIPLE_BODY);
  });

  it("reinforce is NEVER run through evaluate_candidate — emitted directly as an ungated confidence signal (Gap 3 L3 fix)", async () => {
    // Selection: net_score +6 crosses the +3 threshold → a reinforce target
    const selection = selectRetirementReinforcementTargets([makeStronglyPositiveScore()], (id) =>
      id === "some-principle" ? { body: PRINCIPLE_BODY, path: PRINCIPLE_PATH } : null,
    );
    expect(selection.targets).toHaveLength(1);
    expect(selection.targets[0].proposal_kind).toBe("reinforce");
    const target = selection.targets[0];

    // Per SKILL.md Step 0.3: reinforce candidate text is the UNCHANGED baseline_body.
    const proposal = shapeMutationProposal({
      candidateText: target.baseline_body,
      evalResult: null,
      index: 1,
      target,
      ts: "20260711T000000Z",
    });

    // Zero subprocess dispatch — reinforce never calls evaluate_candidate.
    expect(mockRunShell).not.toHaveBeenCalled();

    expect(proposal.frontmatter.proposal_kind).toBe("reinforce");
    expect(proposal.frontmatter.gated).toBe(false);
    expect(proposal.frontmatter.holdout_baseline).toBeNull();
    expect(proposal.frontmatter.holdout_candidate).toBeNull();
    expect(proposal.frontmatter.apply_channel).toBe("writer");
    expect(proposal.markdown).toMatch(/not holdout-gated/i);

    await emitProposal(proposedLearningsDir, proposal.markdown, proposal.filename);
    const written = await readFile(join(proposedLearningsDir, proposal.filename), "utf-8");
    expect(written).toContain("proposal_kind: reinforce");
    expect(written).toContain("gated: false");

    const stillOnDisk = await readFile(
      join(projectDir, "principles", "rules", "some-principle.md"),
      "utf-8",
    );
    expect(stillOnDisk).toBe(PRINCIPLE_BODY);
  });
});
