/**
 * record-applied-evolution.test.ts — record_applied_evolution handler integration tests.
 *
 * Uses a real file-backed drift.db under a temp project dir (mirrors
 * attribute-failure.test.ts). Covers:
 * 1. Happy path: handler writes a row readable via getAppliedEvolutions().
 * 2. Fail-closed: a storage throw → ToolResult error (ok:false), never fail-open.
 * 3. Idempotent re-record: same proposal_id upserts (one row, updated values).
 * 4. INVALID_INPUT on empty proposal_id.
 *
 * Canon principles:
 *   - errors-are-values: handler returns ToolResult, never throws.
 *   - observable-best-effort DEVIATION: this write is authoritative/fail-closed.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppliedEvolutionsDao } from "../../../platform/storage/drift/applied-evolutions-dao.ts";
import {
  evictDriftDbForScope,
  getDriftDb,
} from "../../../platform/storage/drift/drift-db-cache.ts";
import { recordAppliedEvolution } from "../tools/record-applied-evolution.ts";

let tmpProjectDir: string;

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    after_hash: "sha-after",
    applied_at: "2026-07-02T12:00:00.000Z",
    apply_base_commit: "abc123",
    artifact_class: "rule",
    before_hash: "sha-before",
    holdout_baseline: 10,
    holdout_candidate: 12,
    principle_id: "agent-tdd-required",
    project_dir: tmpProjectDir,
    proposal_id: "evolve-20260702-01",
    target_path: "rules/agent-tdd-required.md",
    ...overrides,
  };
}

beforeEach(() => {
  tmpProjectDir = mkdtempSync(join(tmpdir(), "record-applied-evo-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  evictDriftDbForScope(tmpProjectDir);
  try {
    rmSync(tmpProjectDir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

describe("recordAppliedEvolution — happy path", () => {
  it("writes a row readable via getAppliedEvolutions()", async () => {
    const result = await recordAppliedEvolution(baseInput());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.proposal_id).toBe("evolve-20260702-01");

    const row = getDriftDb(tmpProjectDir)
      .getAppliedEvolutions()
      .getByProposalId("evolve-20260702-01");
    expect(row).not.toBeNull();
    expect(row?.target_path).toBe("rules/agent-tdd-required.md");
    expect(row?.holdout_candidate).toBe(12);
    expect(row?.apply_base_commit).toBe("abc123");
    expect(row?.applying_commit).toBeNull();
  });

  it("stores a null principle_id for an agent-def target", async () => {
    const result = await recordAppliedEvolution(
      baseInput({
        artifact_class: "agent",
        principle_id: null,
        proposal_id: "evolve-agent-01",
        target_path: "agents/engineer.md",
      }),
    );
    expect(result.ok).toBe(true);
    const row = getDriftDb(tmpProjectDir).getAppliedEvolutions().getByProposalId("evolve-agent-01");
    expect(row?.principle_id).toBeNull();
  });
});

describe("recordAppliedEvolution — fail-closed", () => {
  it("returns a ToolResult error when the storage write throws", async () => {
    vi.spyOn(AppliedEvolutionsDao.prototype, "record").mockImplementation(() => {
      throw new Error("disk full");
    });
    const result = await recordAppliedEvolution(baseInput());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("UNEXPECTED");
      expect(result.message).toContain("apply-provenance record failed");
    }
  });
});

describe("recordAppliedEvolution — idempotent re-record", () => {
  it("upserts on proposal_id (one row, updated values)", async () => {
    await recordAppliedEvolution(baseInput());
    await recordAppliedEvolution(baseInput({ after_hash: "sha-after-v2", holdout_candidate: 15 }));

    const dao = getDriftDb(tmpProjectDir).getAppliedEvolutions();
    const row = dao.getByProposalId("evolve-20260702-01");
    expect(row?.after_hash).toBe("sha-after-v2");
    expect(row?.holdout_candidate).toBe(15);
    // Only one row exists (upsert, not duplicate).
    expect(dao.listAppliedSince("2026-01-01T00:00:00.000Z")).toHaveLength(1);
  });
});

describe("recordAppliedEvolution — validation", () => {
  it("returns INVALID_INPUT for an empty proposal_id", async () => {
    const result = await recordAppliedEvolution(baseInput({ proposal_id: "" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error_code).toBe("INVALID_INPUT");
  });

  it("returns INVALID_INPUT for an unparseable applied_at", async () => {
    const result = await recordAppliedEvolution(baseInput({ applied_at: "not-a-date" }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
      expect(result.message).toContain("applied_at");
    }
  });
});

describe("recordAppliedEvolution — applied_at ms-precision normalization", () => {
  it("normalizes a seconds-only stamp to full millisecond ISO before storing", async () => {
    // Seconds-only 'Z' stamp sorts BEFORE a same-second ms stamp ('Z' > '.'),
    // which would mis-bucket a boundary event. The recorder must canonicalize.
    const result = await recordAppliedEvolution(
      baseInput({ applied_at: "2026-07-02T12:00:00Z", proposal_id: "evolve-secs-01" }),
    );
    expect(result.ok).toBe(true);
    const row = getDriftDb(tmpProjectDir).getAppliedEvolutions().getByProposalId("evolve-secs-01");
    expect(row?.applied_at).toBe("2026-07-02T12:00:00.000Z");
  });
});
