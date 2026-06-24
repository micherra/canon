/**
 * run-summary-provenance.test.ts
 *
 * Tests for context_provenance surfacing in RunSummary.
 * Verifies the extractContextProvenance join: agent_id back-fill,
 * no-content guarantee, and fail-open behavior.
 *
 * Uses real SQLite via getExecutionStore / clearStoreCache.
 * Workspace paths go through VITEST env skip of .canon/workspaces/ guard.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { AssembledArtifact } from "../../../../domains/workspaces/context-provenance.ts";
import {
  clearStoreCache,
  getExecutionStore,
} from "../../../../domains/workspaces/execution-store-cache.ts";
import { buildRunSummary } from "../run-summary-builder.ts";

// ---- helpers ----

function makeTempWorkspace(): string {
  // VITEST env bypasses the .canon/workspaces/ path guard in getExecutionStore
  return mkdtempSync(join(tmpdir(), "run-summary-prov-test-"));
}

function baseMetadata() {
  return {
    branch: "test/branch",
    flow: "test-flow",
    tier: "small",
    task: "test task",
    archivedAt: new Date().toISOString(),
  };
}

function sampleArtifact(overrides?: Partial<AssembledArtifact>): AssembledArtifact {
  return {
    kind: "rule",
    id: "agent-tdd",
    path: "rules/agent-tdd.md",
    content_hash: "abc123def456abc123def456abc123def456abc123def456abc123def456abc123",
    char_span: [0, 100],
    ...overrides,
  };
}

afterEach(() => {
  clearStoreCache();
});

// ---- core join test ----

describe("extractContextProvenance join", () => {
  test("joins agent_id from back-fill event for the same step_id", () => {
    const workspace = makeTempWorkspace();
    const store = getExecutionStore(workspace);

    const artifact = sampleArtifact();
    // Emit provisional context_provenance with agent_id null
    store.appendEvent("context_provenance", {
      step_id: "implement",
      agent_id: null,
      agent_name: "canon:engineer",
      spawned_at: "2026-06-24T00:00:00.000Z",
      assembled_artifacts: [artifact],
      preload_prompt_hash: "deadbeef",
    });
    // Back-fill with the real agent_id
    store.appendEvent("context_provenance_agent_id", {
      step_id: "implement",
      agent_id: "agent-abc-123",
    });

    const summary = buildRunSummary({
      workspacePath: workspace,
      slug: "test-slug",
      archiveId: "test-archive-id",
      metadata: baseMetadata(),
    });

    expect(summary.context_provenance).toBeDefined();
    expect(summary.context_provenance).toHaveLength(1);

    const entry = summary.context_provenance![0];
    expect(entry.step_id).toBe("implement");
    expect(entry.agent_id).toBe("agent-abc-123");
    expect(entry.agent_name).toBe("canon:engineer");
    expect(entry.artifact_count).toBe(1);
    expect(entry.spawned_at).toBe("2026-06-24T00:00:00.000Z");

    rmSync(workspace, { recursive: true, force: true });
  });

  test("agent_id is null when no back-fill event exists", () => {
    const workspace = makeTempWorkspace();
    const store = getExecutionStore(workspace);

    store.appendEvent("context_provenance", {
      step_id: "review",
      agent_id: null,
      agent_name: "canon:reviewer",
      spawned_at: "2026-06-24T00:01:00.000Z",
      assembled_artifacts: [],
      preload_prompt_hash: "cafebabe",
    });

    const summary = buildRunSummary({
      workspacePath: workspace,
      slug: "test-slug",
      archiveId: "test-archive-id",
      metadata: baseMetadata(),
    });

    expect(summary.context_provenance).toHaveLength(1);
    expect(summary.context_provenance![0].agent_id).toBeNull();

    rmSync(workspace, { recursive: true, force: true });
  });

  test("latest back-fill wins when multiple back-fills for the same step_id", () => {
    const workspace = makeTempWorkspace();
    const store = getExecutionStore(workspace);

    store.appendEvent("context_provenance", {
      step_id: "implement",
      agent_id: null,
      agent_name: "canon:engineer",
      spawned_at: "2026-06-24T00:00:00.000Z",
      assembled_artifacts: [],
      preload_prompt_hash: "hash1",
    });
    store.appendEvent("context_provenance_agent_id", {
      step_id: "implement",
      agent_id: "agent-first",
    });
    store.appendEvent("context_provenance_agent_id", {
      step_id: "implement",
      agent_id: "agent-second",
    });

    const summary = buildRunSummary({
      workspacePath: workspace,
      slug: "test-slug",
      archiveId: "test-archive-id",
      metadata: baseMetadata(),
    });

    // Latest event wins (map overwrite)
    expect(summary.context_provenance![0].agent_id).toBe("agent-second");

    rmSync(workspace, { recursive: true, force: true });
  });
});

// ---- empty / no-event cases ----

describe("empty store / missing events", () => {
  test("returns context_provenance: [] when store has no events", () => {
    const workspace = makeTempWorkspace();
    // Initialize store (creates DB) but append no events
    getExecutionStore(workspace);

    const summary = buildRunSummary({
      workspacePath: workspace,
      slug: "test-slug",
      archiveId: "test-archive-id",
      metadata: baseMetadata(),
    });

    expect(summary.context_provenance).toBeDefined();
    expect(summary.context_provenance).toEqual([]);
    // buildRunSummary must not throw — verified by reaching this point

    rmSync(workspace, { recursive: true, force: true });
  });

  test("returns context_provenance: [] when store has only back-fill events (no provenance events)", () => {
    const workspace = makeTempWorkspace();
    const store = getExecutionStore(workspace);

    store.appendEvent("context_provenance_agent_id", {
      step_id: "implement",
      agent_id: "agent-abc",
    });

    const summary = buildRunSummary({
      workspacePath: workspace,
      slug: "test-slug",
      archiveId: "test-archive-id",
      metadata: baseMetadata(),
    });

    expect(summary.context_provenance).toEqual([]);

    rmSync(workspace, { recursive: true, force: true });
  });
});

// ---- fail-open (broken store) ----

describe("fail-open on broken workspace", () => {
  test("returns context_provenance: [] when workspace has no orchestration.db", () => {
    // A temp dir with no DB file — getExecutionStore would fail if called.
    // buildRunSummary must catch the error and return [].
    const workspace = mkdtempSync(join(tmpdir(), "run-summary-prov-broken-"));

    // Do NOT initialize the store — the directory exists but has no orchestration.db
    const summary = buildRunSummary({
      workspacePath: workspace,
      slug: "test-slug",
      archiveId: "test-archive-id",
      metadata: baseMetadata(),
    });

    expect(summary.context_provenance).toEqual([]);
    // Must not throw
    expect(summary.version).toBe(1);

    rmSync(workspace, { recursive: true, force: true });
  });
});

// ---- no content bloat ----

describe("no content in artifacts", () => {
  test("artifact entries have only hash/span/sidecar keys, no content field", () => {
    const workspace = makeTempWorkspace();
    const store = getExecutionStore(workspace);

    const artifact: AssembledArtifact = {
      kind: "primer",
      id: "backend-data",
      path: "primers/backend-data.md",
      content_hash: "cafebabe00000000cafebabe00000000cafebabe00000000cafebabe00000000",
      char_span: [10, 500],
    };

    store.appendEvent("context_provenance", {
      step_id: "design",
      agent_id: null,
      agent_name: "canon:architect",
      spawned_at: "2026-06-24T00:02:00.000Z",
      assembled_artifacts: [artifact],
      preload_prompt_hash: "beefdead",
    });

    const summary = buildRunSummary({
      workspacePath: workspace,
      slug: "test-slug",
      archiveId: "test-archive-id",
      metadata: baseMetadata(),
    });

    expect(summary.context_provenance).toHaveLength(1);
    const resultArtifact = summary.context_provenance![0].artifacts[0];
    expect(resultArtifact).toBeDefined();

    // Assert only allowed keys are present
    const ALLOWED_KEYS = new Set([
      "kind",
      "id",
      "path",
      "content_hash",
      "char_span",
      "source",
      "sidecar_path",
    ]);
    for (const key of Object.keys(resultArtifact)) {
      expect(ALLOWED_KEYS.has(key)).toBe(true);
    }
    // Explicitly assert no content field
    expect(resultArtifact).not.toHaveProperty("content");

    rmSync(workspace, { recursive: true, force: true });
  });

  test("blanked (sidecar) artifact carries sidecar_path and source=sidecar, not content", () => {
    const workspace = makeTempWorkspace();
    const store = getExecutionStore(workspace);

    const blankedArtifact: AssembledArtifact = {
      kind: "rule",
      id: "agent-minimal-fix",
      path: "rules/agent-minimal-fix.md",
      content_hash: "hash111aaa000111aaa000111aaa000111aaa000111aaa000111aaa000111aaa0",
      char_span: null,
      source: "sidecar",
      sidecar_path: "/tmp/sidecar-data.json",
    };

    store.appendEvent("context_provenance", {
      step_id: "implement",
      agent_id: null,
      agent_name: "canon:engineer",
      spawned_at: "2026-06-24T00:03:00.000Z",
      assembled_artifacts: [blankedArtifact],
      preload_prompt_hash: "hash222",
    });

    const summary = buildRunSummary({
      workspacePath: workspace,
      slug: "test-slug",
      archiveId: "test-archive-id",
      metadata: baseMetadata(),
    });

    const a = summary.context_provenance![0].artifacts[0];
    expect(a.char_span).toBeNull();
    expect(a.source).toBe("sidecar");
    expect(a.sidecar_path).toBe("/tmp/sidecar-data.json");
    expect(a).not.toHaveProperty("content");

    rmSync(workspace, { recursive: true, force: true });
  });
});

// ---- backward compat ----

describe("backward compatibility", () => {
  test("existing run-summary calls with no provenance events still produce a valid RunSummary", () => {
    const workspace = makeTempWorkspace();
    // Don't touch the store at all
    getExecutionStore(workspace); // init DB

    const summary = buildRunSummary({
      workspacePath: workspace,
      slug: "some-slug",
      archiveId: "arch-001",
      metadata: {
        branch: "main",
        flow: "build",
        tier: "medium",
        task: "some task",
        archivedAt: "2026-06-24T00:00:00.000Z",
      },
    });

    // Must be a valid RunSummary
    expect(summary.version).toBe(1);
    expect(summary.archive_id).toBe("arch-001");
    expect(Array.isArray(summary.context_provenance)).toBe(true);
    expect(summary.context_provenance).toEqual([]);

    rmSync(workspace, { recursive: true, force: true });
  });
});
