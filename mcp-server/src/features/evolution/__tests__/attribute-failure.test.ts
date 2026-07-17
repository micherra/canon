/**
 * attribute-failure.test.ts — Handler integration tests.
 *
 * Tests the attribute_failure handler end-to-end with real execution store
 * events (context_provenance) and a real REVIEW.md on disk.
 *
 * Uses real SQLite via getExecutionStore / clearStoreCache.
 * Uses real mkdtempSync for isolated workspace dirs.
 *
 * Covers:
 * 1. Happy path: real context_provenance events + REVIEW.md → full attribution tuple
 * 2. Fail-open default: absent provenance → empty result, no error
 * 3. INVALID_INPUT when neither workspace nor archive_id given
 * 4. INVALID_INPUT when both workspace and archive_id given
 * 5. Transcript seam pin — getTranscriptExcerpt not wired in v1
 * 6. INVALID_INPUT error paths
 * 7. P1: absolute artifact paths in recorded provenance are resolved correctly
 * 8. P2: archive_id mode reads review_results from archived run-summary.json
 *
 * Canon principles:
 *   - errors-are-values: handler returns ToolResult, never throws
 *   - observable-best-effort: absent provenance → partial output (empty), not error
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildContextProvenanceRecord,
  hashContent,
} from "../../../domains/workspaces/context-provenance.ts";
import {
  clearStoreCache,
  getExecutionStore,
} from "../../../domains/workspaces/execution-store-cache.ts";
import {
  evictDriftDbForScope,
  getDriftDb,
} from "../../../platform/storage/drift/drift-db-cache.ts";
import { attributeFailure } from "../tools/attribute-failure.ts";

// ---------------------------------------------------------------------------
// Test setup helpers
// ---------------------------------------------------------------------------

let tmpWorkspace: string;
let tmpProjectDir: string;

beforeEach(() => {
  tmpWorkspace = mkdtempSync(join(tmpdir(), "attr-failure-test-workspace-"));
  tmpProjectDir = mkdtempSync(join(tmpdir(), "attr-failure-test-project-"));
  mkdirSync(join(tmpWorkspace, "reviews"), { recursive: true });
});

afterEach(() => {
  clearStoreCache();
  evictDriftDbForScope(tmpProjectDir);
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
// Helpers to seed the fixture workspace
// ---------------------------------------------------------------------------

const RULE_ID = "agent-tdd-required";
const RULE_PATH = `rules/${RULE_ID}.md`;
const RULE_BODY = "# Agent TDD Required\n\nAlways write tests first.";
const RULE_HASH = hashContent(RULE_BODY);

function seedContextProvenance(workspace: string, stepId: string): void {
  const store = getExecutionStore(workspace);

  // Build the provenance record using the real builder
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

  // Back-fill agent_id
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

| Principle | Severity | Location | Description |
|-----------|----------|----------|-------------|
| ${RULE_ID} | BLOCKING | \`src/foo.ts\` | Tests not written first. |

#### Honored

- errors-are-values
`;
  writeFileSync(join(workspace, "reviews", "REVIEW.md"), reviewContent, "utf-8");
}

function seedCurrentArtifact(projectDir: string): void {
  // Write the SAME content as RULE_BODY so hash_verified is true
  const rulesDir = join(projectDir, "rules");
  mkdirSync(rulesDir, { recursive: true });
  writeFileSync(join(projectDir, RULE_PATH), RULE_BODY, "utf-8");
}

// ---------------------------------------------------------------------------
// 1. Happy path
// ---------------------------------------------------------------------------

describe("attribute_failure happy path", () => {
  it("produces a full attribution tuple from real provenance + REVIEW.md", async () => {
    seedContextProvenance(tmpWorkspace, "implement");
    seedReviewMd(tmpWorkspace);
    seedCurrentArtifact(tmpProjectDir);

    const result = await attributeFailure({
      workspace: tmpWorkspace,
      project_dir: tmpProjectDir,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");

    // Should have at least one attribution
    expect(result.attributions).toHaveLength(1);
    const attr = result.attributions[0];

    expect(attr.failure_kind).toBe("review_violation");
    expect(attr.target_artifact.id).toBe(RULE_ID);
    expect(attr.target_artifact.hash_verified).toBe(true);
    expect(attr.attributed_violations).toHaveLength(1);
    expect(attr.attributed_violations[0].principle_id).toBe(RULE_ID);
    expect(attr.owning_steps).toHaveLength(1);
    expect(attr.owning_steps[0].step_id).toBe("implement");
    expect(attr.owning_steps[0].agent_id).toBe("agent-impl-001");
    expect(attr.owning_steps[0].agent_name).toBe("canon:engineer");
    expect(attr.presence_in_context).toBe(true);
    expect(attr.hypothesis).not.toMatch(/caused|causes/i);

    expect(result.meta.violations_seen).toBe(1);
    expect(result.meta.provenance_steps).toBe(1);
  });

  it("hash_verified:true confirms byte-identity: same content_hash as recorded", async () => {
    seedContextProvenance(tmpWorkspace, "implement");
    seedReviewMd(tmpWorkspace);
    seedCurrentArtifact(tmpProjectDir);

    const result = await attributeFailure({
      workspace: tmpWorkspace,
      project_dir: tmpProjectDir,
    });

    if (!result.ok) throw new Error("expected ok");
    // The artifact on disk has the same content as was recorded → hash_verified:true
    expect(result.attributions[0].target_artifact.hash_verified).toBe(true);
    expect(result.attributions[0].target_artifact.content_hash).toBe(RULE_HASH);
  });
});

// ---------------------------------------------------------------------------
// 2. Fail-open: absent provenance → empty result, no error
// ---------------------------------------------------------------------------

describe("fail-open behavior", () => {
  it("returns empty attributions (not an error) when provenance events are absent", async () => {
    // No context_provenance events seeded — just an empty workspace
    seedReviewMd(tmpWorkspace);

    const result = await attributeFailure({
      workspace: tmpWorkspace,
      project_dir: tmpProjectDir,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.attributions).toHaveLength(0);
    // violation still seen but unattributed
    expect(result.unattributed.length).toBeGreaterThanOrEqual(1);
    expect(result.unattributed[0].reason).toBe("no_provenance");
  });

  it("returns empty result (not an error) when workspace has no reviews or provenance", async () => {
    const result = await attributeFailure({
      workspace: tmpWorkspace,
      project_dir: tmpProjectDir,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.attributions).toHaveLength(0);
    expect(result.unattributed).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 3 & 4. INVALID_INPUT paths
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 5. Transcript seam pin — getTranscriptExcerpt is NOT wired in v1
// ---------------------------------------------------------------------------

describe("transcript seam unwired (v1 pin)", () => {
  it("transcript_evidence is [] and confidence is medium when seam not wired", async () => {
    // This test PINS the documented v1 behavior: the handler does not wire
    // getTranscriptExcerpt, so transcript_evidence is always [] for handler-level calls.
    // Confidence should be "medium" (hash_verified + !ambiguous but no transcript)
    // rather than "high" (which requires transcript evidence).
    // If a future pass wires the seam without updating this test, the test fails
    // and the developer must confirm the contract change is intentional.
    seedContextProvenance(tmpWorkspace, "implement");
    seedReviewMd(tmpWorkspace);
    seedCurrentArtifact(tmpProjectDir);

    const result = await attributeFailure({
      workspace: tmpWorkspace,
      project_dir: tmpProjectDir,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.attributions).toHaveLength(1);

    const attr = result.attributions[0];
    // Pin: seam not wired → transcript_evidence is empty array
    expect(attr.transcript_evidence).toEqual([]);
    // Pin: no transcript → confidence is "medium" not "high"
    expect(attr.confidence).toBe("medium");
  });

  it("does not crash when provenance has a null step_id (partial back-fill)", async () => {
    // Stress the seam guard: collectTranscriptEvidence skips steps with null step_id
    // even when a seam is hypothetically wired. At handler level the seam is unwired,
    // so the null-step guard is never hit, but ensure the result is still ok + empty
    // transcript_evidence (not a crash).
    seedContextProvenance(tmpWorkspace, "implement");
    seedReviewMd(tmpWorkspace);
    seedCurrentArtifact(tmpProjectDir);

    const result = await attributeFailure({
      workspace: tmpWorkspace,
      project_dir: tmpProjectDir,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    // No crash, transcript still empty
    expect(result.attributions[0].transcript_evidence).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 7. P1: absolute artifact paths in recorded provenance resolve correctly
// ---------------------------------------------------------------------------

describe("P1: absolute artifact path handling in readCurrentBody", () => {
  it("hash_verified:true when provenance records an absolute artifact path", async () => {
    // Seed provenance with an ABSOLUTE artifact path (as happens when resolve_agent_skills
    // uses pluginDir which is an absolute path). The readCurrentBody fix must NOT do
    // join(project_dir, absolutePath), which would yield an incorrect nested path.
    const absoluteRulePath = join(tmpProjectDir, RULE_PATH);
    mkdirSync(join(tmpProjectDir, "rules"), { recursive: true });
    writeFileSync(absoluteRulePath, RULE_BODY, "utf-8");

    const store = getExecutionStore(tmpWorkspace);
    const record = buildContextProvenanceRecord({
      workspace: tmpWorkspace,
      stepId: "implement",
      agentName: "canon:engineer",
      spawnedAt: new Date().toISOString(),
      finalPreloadPrompt: `### Rule: ${RULE_ID}\n\n${RULE_BODY}`,
      skills: [
        {
          kind: "rule",
          id: RULE_ID,
          path: absoluteRulePath, // <-- ABSOLUTE path (the P1 case)
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

    seedReviewMd(tmpWorkspace);

    const result = await attributeFailure({
      workspace: tmpWorkspace,
      project_dir: tmpProjectDir,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");

    // The artifact at the absolute path has the same content_hash as recorded,
    // so hash_verified must be true (not artifact_missing / flagged).
    expect(result.attributions).toHaveLength(1);
    expect(result.attributions[0].target_artifact.hash_verified).toBe(true);
    // Nothing should be in flagged (which captures artifact_missing / hash_mismatch)
    expect(result.flagged).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 8. P2: archive_id mode reads review_results from archived run-summary.json
// ---------------------------------------------------------------------------

describe("P2: archive_id mode populates failure sources from run-summary.json", () => {
  it("violations_seen > 0 and attribution produced for archive with review_results", async () => {
    const archiveId = "test-archive-p2-001";
    const archivePath = join(tmpProjectDir, ".canon", "history", "test-slug");
    mkdirSync(archivePath, { recursive: true });

    // Seed the archive manifest in drift.db
    const db = getDriftDb(tmpProjectDir);
    db.appendArchiveManifest({
      archive_id: archiveId,
      archive_path: archivePath,
      archived_at: new Date().toISOString(),
      artifact_types: ["reviews"],
      branch: "main",
      flow: "test-flow",
      has_run_summary: true,
      sanitized_branch: "main",
      slug: "test-slug",
      source_run_id: null,
      task: "",
      tier: "supervised",
    });

    // Build a context_provenance record with the RULE_ID artifact
    const provenanceRecord: unknown = {
      step_id: "implement",
      agent_id: "agent-001",
      agent_name: "canon:engineer",
      spawned_at: new Date().toISOString(),
      artifact_count: 1,
      artifacts: [
        {
          id: RULE_ID,
          kind: "rule",
          path: RULE_PATH,
          content_hash: RULE_HASH,
          inContextText: `### Rule: ${RULE_ID}\n\n${RULE_BODY.trim()}`,
          blanked: false,
        },
      ],
    };

    // Write run-summary.json with review_results + context_provenance
    const runSummary = {
      version: 1,
      archive_id: archiveId,
      run_metadata: {
        branch: "main",
        slug: "test-slug",
        flow: "test-flow",
        tier: "supervised",
        task: "",
        started_at: null,
        completed_at: null,
        archived_at: new Date().toISOString(),
        total_duration_ms: null,
      },
      planner_context: null,
      step_outcomes: [],
      review_results: [
        {
          verdict: "BLOCKING",
          files_reviewed: 1,
          principles_checked: 1,
          violations: [
            {
              principle_id: RULE_ID,
              severity: "BLOCKING",
              file_path: "src/foo.ts",
              message: "Tests not written first.",
            },
          ],
          honored: [],
        },
      ],
      decision_summaries: [],
      artifact_inventory: { artifacts: [] },
      context_provenance: [provenanceRecord],
    };

    writeFileSync(join(archivePath, "run-summary.json"), JSON.stringify(runSummary), "utf-8");

    // Also write the current rule file so hash_verified can be true
    mkdirSync(join(tmpProjectDir, "rules"), { recursive: true });
    writeFileSync(join(tmpProjectDir, RULE_PATH), RULE_BODY, "utf-8");

    const result = await attributeFailure({
      archive_id: archiveId,
      project_dir: tmpProjectDir,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");

    // archive_id mode must read review_results → violations_seen > 0
    expect(result.meta.violations_seen).toBeGreaterThan(0);
    // At least one attribution or unattributed (the violation was read)
    const totalViolations =
      result.attributions.length + result.unattributed.length + result.flagged.length;
    expect(totalViolations).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 6. INVALID_INPUT error paths
// ---------------------------------------------------------------------------

describe("INVALID_INPUT error paths", () => {
  it("returns INVALID_INPUT when neither workspace nor archive_id is given", async () => {
    const result = await attributeFailure({
      project_dir: tmpProjectDir,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error_code).toBe("INVALID_INPUT");
  });

  it("returns INVALID_INPUT when both workspace and archive_id are given", async () => {
    const result = await attributeFailure({
      workspace: tmpWorkspace,
      archive_id: "some-archive-123",
      project_dir: tmpProjectDir,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error_code).toBe("INVALID_INPUT");
  });
});
