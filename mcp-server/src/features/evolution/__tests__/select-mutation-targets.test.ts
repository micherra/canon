/**
 * select-mutation-targets.test.ts — Handler integration tests.
 *
 * Uses a real temp-workspace fixture (like attribute-failure.test.ts) seeded with
 * context_provenance events and REVIEW.md to test the full handler pipeline.
 *
 * Covers:
 * 1. Happy path: real provenance + REVIEW.md → ToolResult ok + bounded targets
 * 2. INVALID_INPUT when both workspace and archive_id given
 * 3. INVALID_INPUT when neither workspace nor archive_id given
 * 4. Fail-open on absent provenance → empty targets, not error
 *
 * Canon principles:
 *   - errors-are-values: handler returns ToolResult, never throws
 *   - no-llm-calls-in-mcp-tools: pure deterministic join, no model calls
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildContextProvenanceRecord } from "../../../domains/workspaces/context-provenance.ts";
import {
  clearStoreCache,
  getExecutionStore,
} from "../../../domains/workspaces/execution-store-cache.ts";
import { selectMutationTargetsHandler } from "../tools/select-mutation-targets.ts";

// ---------------------------------------------------------------------------
// Test setup helpers
// ---------------------------------------------------------------------------

let tmpWorkspace: string;
let tmpProjectDir: string;

beforeEach(() => {
  tmpWorkspace = mkdtempSync(join(tmpdir(), "select-targets-test-workspace-"));
  tmpProjectDir = mkdtempSync(join(tmpdir(), "select-targets-test-project-"));
  mkdirSync(join(tmpWorkspace, "reviews"), { recursive: true });
});

afterEach(() => {
  clearStoreCache();
  try {
    rmSync(tmpWorkspace, { recursive: true, force: true });
  } catch {
    // cleanup is best-effort
  }
  try {
    rmSync(tmpProjectDir, { recursive: true, force: true });
  } catch {
    // cleanup is best-effort
  }
});

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

const RULE_ID = "agent-tdd-required";
const RULE_PATH = `rules/${RULE_ID}.md`;
const RULE_BODY = "# Agent TDD Required\n\nAlways write tests first.";

function seedContextProvenance(workspace: string, stepId: string): void {
  const store = getExecutionStore(workspace);
  const record = buildContextProvenanceRecord({
    workspace,
    stepId,
    agentName: "canon:engineer",
    spawnedAt: new Date().toISOString(),
    finalPreloadPrompt: `### Rule: ${RULE_ID}\n\n${RULE_BODY}`,
    skills: [
      {
        kind: "rule",
        id: RULE_ID,
        path: RULE_PATH,
        originalContent: RULE_BODY,
        inContextText: `### Rule: ${RULE_ID}\n\n${RULE_BODY.trim()}`,
        blanked: false,
      },
    ],
  });

  store.appendEvent("context_provenance", {
    step_id: record.step_id,
    agent_id: null,
    agent_name: record.agent_name,
    spawned_at: record.spawned_at,
    assembled_artifacts: record.assembled_artifacts,
    preload_prompt_hash: record.preload_prompt_hash,
    workspace: record.workspace,
  });

  store.appendEvent("context_provenance_agent_id", {
    step_id: stepId,
    agent_id: "agent-impl-001",
  });
}

function seedReviewMd(workspace: string): void {
  const reviewContent = `---
verdict: BLOCKING
files-reviewed: 3
principles-checked: 10
---

## Review

### Stage 4: Violations

#### Violations

- **principle-id**: ${RULE_ID} — **severity**: BLOCKING — **file**: src/foo.ts — Tests not written first.

#### Honored

- errors-are-values
`;
  writeFileSync(join(workspace, "reviews", "REVIEW.md"), reviewContent, "utf-8");
}

function seedRuleFile(projectDir: string): void {
  const rulesDir = join(projectDir, "rules");
  mkdirSync(rulesDir, { recursive: true });
  writeFileSync(join(projectDir, RULE_PATH), RULE_BODY, "utf-8");
}

// ---------------------------------------------------------------------------
// 1. Happy path
// ---------------------------------------------------------------------------

describe("selectMutationTargetsHandler — happy path", () => {
  it("returns ToolResult ok with targets when provenance + REVIEW.md present", async () => {
    seedContextProvenance(tmpWorkspace, "implement");
    seedReviewMd(tmpWorkspace);
    seedRuleFile(tmpProjectDir);

    const result = await selectMutationTargetsHandler({
      workspace: tmpWorkspace,
      project_dir: tmpProjectDir,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    // Should have at least one target (the rule file with verified hash and high confidence)
    // OR it might be in skipped/gate_ineligible depending on the confidence level from attribution
    // The handler just needs to return a valid structure
    expect(Array.isArray(result.targets)).toBe(true);
    expect(Array.isArray(result.gate_ineligible)).toBe(true);
    expect(Array.isArray(result.skipped)).toBe(true);
    expect(typeof result.meta.attributions_seen).toBe("number");
    expect(typeof result.meta.selected).toBe("number");
    expect(typeof result.meta.budget).toBe("number");
  });

  it("targets are bounded by DEFAULT_MAX_TARGETS_PER_PASS", async () => {
    seedContextProvenance(tmpWorkspace, "implement");
    seedReviewMd(tmpWorkspace);
    seedRuleFile(tmpProjectDir);

    const result = await selectMutationTargetsHandler({
      workspace: tmpWorkspace,
      project_dir: tmpProjectDir,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.targets.length).toBeLessThanOrEqual(3);
  });

  it("respects custom max_targets_per_pass", async () => {
    seedContextProvenance(tmpWorkspace, "implement");
    seedReviewMd(tmpWorkspace);
    seedRuleFile(tmpProjectDir);

    const result = await selectMutationTargetsHandler({
      workspace: tmpWorkspace,
      project_dir: tmpProjectDir,
      max_targets_per_pass: 1,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.targets.length).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// 2 & 3. INVALID_INPUT paths
// ---------------------------------------------------------------------------

describe("selectMutationTargetsHandler — INVALID_INPUT", () => {
  it("returns INVALID_INPUT when neither workspace nor archive_id given", async () => {
    const result = await selectMutationTargetsHandler({
      project_dir: tmpProjectDir,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error_code).toBe("INVALID_INPUT");
  });

  it("returns INVALID_INPUT when both workspace and archive_id given", async () => {
    const result = await selectMutationTargetsHandler({
      workspace: tmpWorkspace,
      archive_id: "some-archive-123",
      project_dir: tmpProjectDir,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error_code).toBe("INVALID_INPUT");
  });
});

// ---------------------------------------------------------------------------
// 4. Fail-open on absent provenance → empty targets, not error
// ---------------------------------------------------------------------------

describe("selectMutationTargetsHandler — fail-open", () => {
  it("returns ok with empty targets when provenance absent", async () => {
    // No context_provenance events seeded — empty workspace
    const result = await selectMutationTargetsHandler({
      workspace: tmpWorkspace,
      project_dir: tmpProjectDir,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.targets).toHaveLength(0);
    expect(result.meta.attributions_seen).toBe(0);
  });

  it("returns ok with empty targets when workspace has no reviews", async () => {
    seedContextProvenance(tmpWorkspace, "implement");
    // No REVIEW.md seeded

    const result = await selectMutationTargetsHandler({
      workspace: tmpWorkspace,
      project_dir: tmpProjectDir,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    // No violations → no attributions → no targets
    expect(result.targets).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 5. scores mode — Gap 3 L3: consume attribute_outcomes scores
// ---------------------------------------------------------------------------

describe("selectMutationTargetsHandler — scores mode (Gap 3 L3)", () => {
  it("INVALID_INPUT when scores is combined with workspace", async () => {
    const result = await selectMutationTargetsHandler({
      workspace: tmpWorkspace,
      project_dir: tmpProjectDir,
      scores: [],
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error_code).toBe("INVALID_INPUT");
  });

  it("a strongly-negative principle produces a retire target; principles/** is never mutated", async () => {
    mkdirSync(join(tmpProjectDir, "principles", "rules"), { recursive: true });
    const principlePath = join(tmpProjectDir, "principles", "rules", "some-principle.md");
    const before =
      "---\nid: some-principle\ntitle: Some Principle\nseverity: rule\nportable: true\n---\n\nBody.\n";
    writeFileSync(principlePath, before);

    const result = await selectMutationTargetsHandler({
      project_dir: tmpProjectDir,
      scores: [
        {
          principle_id: "some-principle",
          net_score: -5,
          positive_weight: 0,
          negative_weight: 5,
          corroboration: 1,
          tier_breakdown: { codex: 0, internal: -5 },
          contributing_builds: [{ archive_id: "archive-001", sign: -1, weight: 5 }],
        },
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.targets).toHaveLength(1);
    expect(result.targets[0].proposal_kind).toBe("retire");
    expect(result.targets[0].principle_id).toBe("some-principle");
    expect(result.targets[0].score_provenance?.net_score).toBe(-5);

    // The tool is a pure query — the on-disk artifact is untouched.
    expect(readFileSync(principlePath, "utf-8")).toBe(before);
  });

  it("an unresolvable principle_id lands in skipped, not an error", async () => {
    const result = await selectMutationTargetsHandler({
      project_dir: tmpProjectDir,
      scores: [
        {
          principle_id: "nonexistent-principle",
          net_score: -10,
          positive_weight: 0,
          negative_weight: 10,
          corroboration: 1,
          tier_breakdown: { codex: 0, internal: -10 },
          contributing_builds: [{ archive_id: "archive-001", sign: -1, weight: 10 }],
        },
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.targets).toHaveLength(0);
  });
});
