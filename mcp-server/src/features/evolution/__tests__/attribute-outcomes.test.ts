/**
 * attribute-outcomes.test.ts — Handler integration tests for attribute_outcomes.
 *
 * Uses real archive fixtures (drift.db build_archives manifest + run-summary.json on
 * disk), mirroring attribute-failure.test.ts's "P2: archive_id mode" pattern, extended
 * to a multi-archive corpus (attribute_outcomes aggregates across builds by design).
 *
 * Covers (per gap3-02-tool-PLAN.md "Tests to write"):
 * (a) fixed corpus fixture -> asserted score map
 * (b) run twice -> deep-equal (determinism, dc-01)
 * (c) two-sided: a build honoring principle X + a build violating X -> net reflects
 *     both with correct sign (dc-03)
 * (d) fail-open: no provenance/archives -> empty scores, ok:true
 * (e) INVALID_INPUT when project_dir missing
 * (f) no-LLM grep over the handler + service files
 *
 * Canon principles:
 *   - errors-are-values: handler returns ToolResult, never throws
 *   - command-query-separation: the tool mutates nothing (asserted by absence of
 *     write seams reachable from these tests — no fs writes to project_dir/.canon)
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashContent } from "../../../domains/workspaces/context-provenance.ts";
import {
  evictDriftDbForScope,
  getDriftDb,
} from "../../../platform/storage/drift/drift-db-cache.ts";
import { attributeOutcomes } from "../tools/attribute-outcomes.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Test setup helpers
// ---------------------------------------------------------------------------

let tmpProjectDir: string;

beforeEach(() => {
  tmpProjectDir = mkdtempSync(join(tmpdir(), "attr-outcomes-test-project-"));
});

afterEach(() => {
  evictDriftDbForScope(tmpProjectDir);
  try {
    rmSync(tmpProjectDir, { recursive: true, force: true });
  } catch {
    // cleanup is best-effort
  }
});

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const RULE_ID = "agent-tdd-required";
const RULE_PATH = `rules/${RULE_ID}.md`;
// Frontmatter `id:` is required for buildCorpusArtifactLookup's dir-scan to index this
// file (corpus-artifact-lookup.ts) — needed by the corpus-fallback join tests below,
// which resolve RULE_ID against the on-disk rules/ dir with no provenance candidate.
const RULE_BODY =
  "---\nid: agent-tdd-required\n---\n\n# Agent TDD Required\n\nAlways write tests first.";
const RULE_HASH = hashContent(RULE_BODY);

function seedRuleFile(projectDir: string): void {
  const rulesDir = join(projectDir, "rules");
  mkdirSync(rulesDir, { recursive: true });
  writeFileSync(join(projectDir, RULE_PATH), RULE_BODY, "utf-8");
}

function provenanceRecord(stepId: string, agentName: string) {
  return {
    agent_id: "agent-001",
    agent_name: agentName,
    artifact_count: 1,
    artifacts: [
      {
        char_span: [0, RULE_BODY.length],
        content_hash: RULE_HASH,
        id: RULE_ID,
        kind: "rule",
        path: RULE_PATH,
        trust_tier: "trusted",
      },
    ],
    spawned_at: "2026-01-01T00:00:00.000Z",
    step_id: stepId,
  };
}

/** Seed an archive manifest row + a run-summary.json on disk. */
function seedArchive(opts: {
  projectDir: string;
  archiveId: string;
  slug: string;
  completedAt: string | null;
  verdict: string;
  violations?: Array<{
    principle_id: string;
    severity: string;
    file_path: string | null;
    message: string;
  }>;
  honored?: string[];
  stepId: string;
  agentName: string;
  /** Omit context_provenance entirely — simulates the 479-of-593 no-provenance builds
   *  the corpus-fallback join exists to recover (ADR-0062, Bug-1 part (d)). */
  noProvenance?: boolean;
}): void {
  const archivePath = join(opts.projectDir, ".canon", "history", opts.slug);
  mkdirSync(archivePath, { recursive: true });

  const db = getDriftDb(opts.projectDir);
  db.appendArchiveManifest({
    archive_id: opts.archiveId,
    archive_path: archivePath,
    archived_at: opts.completedAt ?? "2026-01-01T00:00:00.000Z",
    artifact_types: ["reviews"],
    branch: "main",
    flow: "test-flow",
    has_run_summary: true,
    sanitized_branch: "main",
    slug: opts.slug,
    source_run_id: null,
    task: "",
    tier: "supervised",
  });

  const runSummary = {
    archive_id: opts.archiveId,
    artifact_inventory: { directories: [], files: [], total_files: 0 },
    context_provenance: opts.noProvenance ? [] : [provenanceRecord(opts.stepId, opts.agentName)],
    decision_summaries: [],
    planner_context: null,
    review_results: [
      {
        files_reviewed: 1,
        honored: opts.honored ?? [],
        principles_checked: 1,
        verdict: opts.verdict,
        violations: opts.violations ?? [],
      },
    ],
    run_metadata: {
      archived_at: opts.completedAt ?? "2026-01-01T00:00:00.000Z",
      branch: "main",
      completed_at: opts.completedAt,
      flow: "test-flow",
      slug: opts.slug,
      started_at: null,
      task: "",
      tier: "supervised",
      total_duration_ms: null,
    },
    step_outcomes: [],
    version: 1,
  };

  writeFileSync(join(archivePath, "run-summary.json"), JSON.stringify(runSummary), "utf-8");
}

// ---------------------------------------------------------------------------
// (a) Fixed corpus fixture -> asserted score map
// ---------------------------------------------------------------------------

describe("attribute_outcomes — fixed corpus fixture", () => {
  it("produces a signed score for the violated principle", async () => {
    seedRuleFile(tmpProjectDir);
    seedArchive({
      agentName: "canon:engineer",
      archiveId: "archive-1",
      completedAt: "2026-01-01T00:00:00.000Z",
      projectDir: tmpProjectDir,
      slug: "slug-1",
      stepId: "implement",
      verdict: "blocking",
      violations: [
        {
          file_path: "src/foo.ts",
          message: "Tests not written first.",
          principle_id: RULE_ID,
          severity: "BLOCKING",
        },
      ],
    });

    const result = await attributeOutcomes({ project_dir: tmpProjectDir });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.scores).toHaveLength(1);
    expect(result.scores[0].principle_id).toBe(RULE_ID);
    expect(result.scores[0].net_score).toBeLessThan(0);
    expect(result.scores[0].negative_weight).toBeGreaterThan(0);
    expect(result.scores[0].positive_weight).toBe(0);
    expect(result.scores[0].contributing_builds).toEqual([
      { archive_id: "archive-1", sign: -1, weight: result.scores[0].net_score },
    ]);
  });
});

// ---------------------------------------------------------------------------
// (b) Determinism (dc-01): run twice -> deep-equal
// ---------------------------------------------------------------------------

describe("attribute_outcomes — determinism (dc-01)", () => {
  it("running the same corpus twice produces deep-equal results", async () => {
    seedRuleFile(tmpProjectDir);
    seedArchive({
      agentName: "canon:engineer",
      archiveId: "archive-1",
      completedAt: "2026-01-01T00:00:00.000Z",
      projectDir: tmpProjectDir,
      slug: "slug-1",
      stepId: "implement",
      verdict: "warning",
      violations: [
        { file_path: "src/foo.ts", message: "m", principle_id: RULE_ID, severity: "WARNING" },
      ],
    });

    const first = await attributeOutcomes({
      now: "2026-01-10T00:00:00.000Z",
      project_dir: tmpProjectDir,
    });
    const second = await attributeOutcomes({
      now: "2026-01-10T00:00:00.000Z",
      project_dir: tmpProjectDir,
    });

    expect(first).toEqual(second);
  });
});

// ---------------------------------------------------------------------------
// (c) Two-sided (dc-03): honoring build + violating build -> net reflects both
// ---------------------------------------------------------------------------

describe("attribute_outcomes — two-sided net score (dc-03)", () => {
  it("combines a honoring build and a violating build with correct sign", async () => {
    seedRuleFile(tmpProjectDir);
    seedArchive({
      agentName: "canon:reviewer",
      archiveId: "archive-honor",
      completedAt: "2026-01-01T00:00:00.000Z",
      honored: [`**${RULE_ID}**: consistently applied`],
      projectDir: tmpProjectDir,
      slug: "slug-honor",
      stepId: "review",
      verdict: "clean",
    });
    seedArchive({
      agentName: "canon:engineer",
      archiveId: "archive-violate",
      completedAt: "2026-01-02T00:00:00.000Z",
      projectDir: tmpProjectDir,
      slug: "slug-violate",
      stepId: "implement",
      verdict: "blocking",
      violations: [
        { file_path: "src/foo.ts", message: "m", principle_id: RULE_ID, severity: "BLOCKING" },
      ],
    });

    const result = await attributeOutcomes({
      archive_ids: ["archive-honor", "archive-violate"],
      now: "2026-01-05T00:00:00.000Z",
      project_dir: tmpProjectDir,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.scores).toHaveLength(1);
    const score = result.scores[0];
    expect(score.positive_weight).toBeGreaterThan(0);
    expect(score.negative_weight).toBeGreaterThan(0);
    expect(score.net_score).toBeCloseTo(score.positive_weight - score.negative_weight, 10);
    expect(score.contributing_builds.map((c) => c.archive_id).sort()).toEqual([
      "archive-honor",
      "archive-violate",
    ]);
  });
});

// ---------------------------------------------------------------------------
// (d) Fail-open: no archives -> empty scores, ok:true
// ---------------------------------------------------------------------------

describe("attribute_outcomes — fail-open", () => {
  it("returns empty scores (not an error) when no archives exist", async () => {
    const result = await attributeOutcomes({ project_dir: tmpProjectDir });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.scores).toEqual([]);
    expect(result.meta.builds_seen).toBe(0);
  });

  it("skips an archive whose run-summary.json is missing without failing the whole call", async () => {
    const db = getDriftDb(tmpProjectDir);
    db.appendArchiveManifest({
      archive_id: "archive-missing-summary",
      archive_path: join(tmpProjectDir, ".canon", "history", "ghost-slug"),
      archived_at: "2026-01-01T00:00:00.000Z",
      artifact_types: [],
      branch: "main",
      flow: "test-flow",
      has_run_summary: false,
      sanitized_branch: "main",
      slug: "ghost-slug",
      source_run_id: null,
      task: "",
      tier: "supervised",
    });

    const result = await attributeOutcomes({ project_dir: tmpProjectDir });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.scores).toEqual([]);
    expect(result.meta.builds_seen).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// (e) INVALID_INPUT when project_dir missing
// ---------------------------------------------------------------------------

describe("attribute_outcomes — INVALID_INPUT", () => {
  it("returns INVALID_INPUT when project_dir is empty", async () => {
    const result = await attributeOutcomes({ project_dir: "" });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error_code).toBe("INVALID_INPUT");
  });
});

// ---------------------------------------------------------------------------
// (g) Corpus-fallback join — handler injects the shared lookup (ADR-0062, part (d))
// ---------------------------------------------------------------------------

describe("attribute_outcomes — corpus-fallback join", () => {
  it("attributes positively end-to-end for a provenance-less archive citing a fixture principle on disk", async () => {
    seedRuleFile(tmpProjectDir);
    seedArchive({
      agentName: "canon:reviewer",
      archiveId: "archive-no-prov",
      completedAt: "2026-01-01T00:00:00.000Z",
      honored: [`**${RULE_ID}**: consistently applied`],
      noProvenance: true,
      projectDir: tmpProjectDir,
      slug: "slug-no-prov",
      stepId: "review",
      verdict: "clean",
    });

    const result = await attributeOutcomes({ project_dir: tmpProjectDir });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.scores).toHaveLength(1);
    expect(result.scores[0].principle_id).toBe(RULE_ID);
    expect(result.scores[0].net_score).toBeGreaterThan(0);
    expect(result.scores[0].positive_weight).toBeGreaterThan(0);
    expect(result.unattributed_positive).toEqual([]);
  });

  it("fail-open: a provenance-less citation whose id is not on disk anywhere stays unattributed, no throw", async () => {
    // No seedRuleFile — the fixture corpus has zero artifacts on disk.
    seedArchive({
      agentName: "canon:reviewer",
      archiveId: "archive-no-artifact",
      completedAt: "2026-01-01T00:00:00.000Z",
      honored: [`**${RULE_ID}**: consistently applied`],
      noProvenance: true,
      projectDir: tmpProjectDir,
      slug: "slug-no-artifact",
      stepId: "review",
      verdict: "clean",
    });

    const result = await attributeOutcomes({ project_dir: tmpProjectDir });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.scores).toEqual([]);
    expect(result.unattributed_positive).toHaveLength(1);
    expect(result.unattributed_positive[0].reason).toBe("no_corpus_artifact");
  });
});

// ---------------------------------------------------------------------------
// (f) No-LLM grep over the handler + service files
// ---------------------------------------------------------------------------

describe("attribute_outcomes — no-LLM verification", () => {
  /**
   * Both files' headers document the grep command in prose (e.g. "NEVER
   * Date.now()") — the repo-wide convention for this self-verification is
   * "zero hits (except this comment)" (see attribution-weight.ts, positive-
   * attribution.ts). Strip comment lines (` * ...`, `/** ` openers) before
   * scanning so the check targets executable code, not its own documentation.
   */
  const FORBIDDEN_MARKERS =
    /anthropic|claude -p|messages\.create|model:|Date\.now\(\)|Math\.random\(\)/i;
  const COMMENT_LINE = /^\s*(\/\*\*|\*\/?|\/\/)/;

  function codeLinesMatching(filePath: string): string[] {
    const lines = readFileSync(filePath, "utf-8").split("\n");
    return lines.filter((line) => !COMMENT_LINE.test(line) && FORBIDDEN_MARKERS.test(line));
  }

  it("the handler and service files contain zero LLM-call or wall-clock markers in code", () => {
    const files = [
      join(__dirname, "..", "tools", "attribute-outcomes.ts"),
      join(__dirname, "..", "services", "outcome-attribution.ts"),
    ];
    for (const file of files) {
      expect(codeLinesMatching(file)).toEqual([]);
    }
  });
});
