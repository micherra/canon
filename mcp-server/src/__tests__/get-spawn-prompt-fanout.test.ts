/**
 * Tests for fan-out behavior in getSpawnPrompt when single states have clusters.
 *
 * Covers:
 * - When single state has clusters, produces one prompt per cluster with correct item substitution
 * - When single state has no clusters, produces exactly one prompt
 * - fanned_out is true when clusters expand a single state
 * - fanned_out is absent/false when no fan-out happens
 * - Cluster item shape matches { cluster_key, files, file_count }
 * - Template paths are applied to every cluster prompt
 * - Role substitution still works on fanned-out single prompts
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Hoist mocks before module import
// ---------------------------------------------------------------------------

vi.mock("../orchestration/board.ts", () => ({
  readBoard: vi.fn(),
  writeBoard: vi.fn(),
}));

vi.mock("../orchestration/wave-briefing.ts", () => ({
  readWaveGuidance: vi.fn().mockResolvedValue(""),
  assembleWaveBriefing: vi.fn().mockReturnValue(undefined),
}));

vi.mock("../orchestration/diff-cluster.ts", () => ({
  clusterDiff: vi.fn(),
}));

import { readBoard } from "../orchestration/board.ts";
import { clusterDiff } from "../orchestration/diff-cluster.ts";
import { getSpawnPrompt } from "../tools/get-spawn-prompt.ts";
import type { Board, ResolvedFlow } from "../orchestration/flow-schema.ts";
import type { FileCluster } from "../orchestration/diff-cluster.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "gsp-fanout-test-"));
  tmpDirs.push(dir);
  return dir;
}

function makeBoard(overrides: Record<string, unknown> = {}): Board {
  return {
    flow: "test-flow",
    task: "test task",
    entry: "review",
    current_state: "review",
    base_commit: "abc1234",
    started: new Date().toISOString(),
    last_updated: new Date().toISOString(),
    states: {},
    iterations: {},
    blocked: null,
    concerns: [],
    skipped: [],
    ...overrides,
  } as Board;
}

function makeSingleReviewFlow(overrides: Partial<ResolvedFlow> = {}): ResolvedFlow {
  return {
    name: "test-review-flow",
    description: "Test review flow",
    entry: "review",
    states: {
      review: {
        type: "single",
        agent: "canon-reviewer",
        large_diff_threshold: 5,
      },
      done: { type: "terminal" },
    },
    spawn_instructions: {
      review: "Review cluster ${item.cluster_key} files: ${item.files} (${item.file_count} files)",
    },
    ...overrides,
  };
}

const sampleClusters: FileCluster[] = [
  { key: "src/api", files: ["src/api/orders.ts", "src/api/users.ts"] },
  { key: "src/ui", files: ["src/ui/Dashboard.svelte", "src/ui/Sidebar.svelte", "src/ui/Header.svelte"] },
];

afterEach(() => {
  for (const d of tmpDirs) {
    rmSync(d, { recursive: true, force: true });
  }
  tmpDirs = [];
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Fan-out when clusters are present
// ---------------------------------------------------------------------------

describe("getSpawnPrompt — single state fan-out with clusters", () => {
  it("produces one prompt per cluster when clusters are present", async () => {
    const workspace = makeTmpDir();
    vi.mocked(readBoard).mockResolvedValue(makeBoard());
    vi.mocked(clusterDiff).mockReturnValue(sampleClusters);

    const flow = makeSingleReviewFlow();
    const result = await getSpawnPrompt({
      workspace,
      state_id: "review",
      flow,
      variables: { task: "review the PR" },
    });

    expect(result.prompts).toHaveLength(sampleClusters.length);
  });

  it("sets fanned_out to true when clusters expand a single state", async () => {
    const workspace = makeTmpDir();
    vi.mocked(readBoard).mockResolvedValue(makeBoard());
    vi.mocked(clusterDiff).mockReturnValue(sampleClusters);

    const flow = makeSingleReviewFlow();
    const result = await getSpawnPrompt({
      workspace,
      state_id: "review",
      flow,
      variables: { task: "review the PR" },
    });

    expect(result.fanned_out).toBe(true);
  });

  it("each prompt is scoped to its cluster with correct item substitution", async () => {
    const workspace = makeTmpDir();
    vi.mocked(readBoard).mockResolvedValue(makeBoard());
    vi.mocked(clusterDiff).mockReturnValue(sampleClusters);

    const flow = makeSingleReviewFlow();
    const result = await getSpawnPrompt({
      workspace,
      state_id: "review",
      flow,
      variables: { task: "review the PR" },
    });

    // First cluster
    expect(result.prompts[0].prompt).toContain("src/api");
    expect(result.prompts[0].prompt).toContain("src/api/orders.ts");
    expect(result.prompts[0].prompt).toContain("2 files");

    // Second cluster
    expect(result.prompts[1].prompt).toContain("src/ui");
    expect(result.prompts[1].prompt).toContain("src/ui/Dashboard.svelte");
    expect(result.prompts[1].prompt).toContain("3 files");
  });

  it("cluster item shape matches { cluster_key, files, file_count }", async () => {
    const workspace = makeTmpDir();
    vi.mocked(readBoard).mockResolvedValue(makeBoard());
    vi.mocked(clusterDiff).mockReturnValue(sampleClusters);

    const flow = makeSingleReviewFlow();
    const result = await getSpawnPrompt({
      workspace,
      state_id: "review",
      flow,
      variables: { task: "review the PR" },
    });

    const firstEntry = result.prompts[0];
    expect(firstEntry.item).toBeDefined();
    const item = firstEntry.item as Record<string, unknown>;
    expect(item).toHaveProperty("cluster_key", "src/api");
    expect(item).toHaveProperty("files");
    expect(item).toHaveProperty("file_count", 2);
  });

  it("uses the same agent for all cluster prompts", async () => {
    const workspace = makeTmpDir();
    vi.mocked(readBoard).mockResolvedValue(makeBoard());
    vi.mocked(clusterDiff).mockReturnValue(sampleClusters);

    const flow = makeSingleReviewFlow();
    const result = await getSpawnPrompt({
      workspace,
      state_id: "review",
      flow,
      variables: {},
    });

    for (const entry of result.prompts) {
      expect(entry.agent).toBe("canon-reviewer");
    }
  });

  it("applies template_paths to every cluster prompt", async () => {
    const workspace = makeTmpDir();
    vi.mocked(readBoard).mockResolvedValue(makeBoard());
    vi.mocked(clusterDiff).mockReturnValue(sampleClusters);

    const flow = makeSingleReviewFlow({
      states: {
        review: {
          type: "single",
          agent: "canon-reviewer",
          large_diff_threshold: 5,
          template: "review-template",
        },
        done: { type: "terminal" },
      },
    });

    const result = await getSpawnPrompt({
      workspace,
      state_id: "review",
      flow,
      variables: { CANON_PLUGIN_ROOT: "/plugin", task: "test" },
    });

    expect(result.prompts).toHaveLength(sampleClusters.length);
    for (const entry of result.prompts) {
      expect(entry.template_paths).toEqual(["/plugin/templates/review-template.md"]);
    }
  });

  it("role substitution applies to all fanned-out single prompts", async () => {
    const workspace = makeTmpDir();
    vi.mocked(readBoard).mockResolvedValue(makeBoard());
    vi.mocked(clusterDiff).mockReturnValue(sampleClusters);

    const flow = makeSingleReviewFlow({
      spawn_instructions: {
        review: "As ${role}, review cluster ${item.cluster_key}: ${item.files}",
      },
    });

    const result = await getSpawnPrompt({
      workspace,
      state_id: "review",
      flow,
      variables: {},
      role: "security-reviewer",
    });

    expect(result.prompts).toHaveLength(sampleClusters.length);
    for (const entry of result.prompts) {
      expect(entry.prompt).toContain("security-reviewer");
      expect(entry.role).toBe("security-reviewer");
    }
  });

});

// ---------------------------------------------------------------------------
// No fan-out when clusters are absent
// ---------------------------------------------------------------------------

describe("getSpawnPrompt — single state without clusters (no fan-out)", () => {
  it("produces exactly one prompt when clusters are null (below threshold)", async () => {
    const workspace = makeTmpDir();
    vi.mocked(readBoard).mockResolvedValue(makeBoard());
    vi.mocked(clusterDiff).mockReturnValue(null);

    const flow = makeSingleReviewFlow({
      spawn_instructions: { review: "Review all the files." },
    });

    const result = await getSpawnPrompt({
      workspace,
      state_id: "review",
      flow,
      variables: {},
    });

    expect(result.prompts).toHaveLength(1);
  });

  it("fanned_out is absent when no fan-out happens (null clusters)", async () => {
    const workspace = makeTmpDir();
    vi.mocked(readBoard).mockResolvedValue(makeBoard());
    vi.mocked(clusterDiff).mockReturnValue(null);

    const flow = makeSingleReviewFlow();
    const result = await getSpawnPrompt({
      workspace,
      state_id: "review",
      flow,
      variables: {},
    });

    expect(result.fanned_out).toBeUndefined();
  });

  it("fanned_out is absent for single state with no large_diff_threshold", async () => {
    const workspace = makeTmpDir();
    vi.mocked(readBoard).mockResolvedValue(makeBoard());
    // clusterDiff should not be called since no large_diff_threshold set
    vi.mocked(clusterDiff).mockReturnValue(null);

    const flow: ResolvedFlow = {
      name: "test-flow",
      description: "Test",
      entry: "review",
      states: {
        review: { type: "single", agent: "canon-reviewer" },
        done: { type: "terminal" },
      },
      spawn_instructions: { review: "Review everything." },
    };

    const result = await getSpawnPrompt({
      workspace,
      state_id: "review",
      flow,
      variables: {},
    });

    expect(result.prompts).toHaveLength(1);
    expect(result.fanned_out).toBeUndefined();
  });

  it("produces exactly one prompt when clusters is empty array (edge case)", async () => {
    const workspace = makeTmpDir();
    vi.mocked(readBoard).mockResolvedValue(makeBoard());
    // clusterDiff returns empty array (unusual but possible)
    vi.mocked(clusterDiff).mockReturnValue([]);

    const flow = makeSingleReviewFlow();
    const result = await getSpawnPrompt({
      workspace,
      state_id: "review",
      flow,
      variables: {},
    });

    // Empty clusters array should fall through to single prompt
    expect(result.prompts).toHaveLength(1);
    expect(result.fanned_out).toBeUndefined();
  });
});

describe("getSpawnPrompt — compete expansion", () => {
  it("expands a single state into multiple prompts when compete is configured", async () => {
    const workspace = makeTmpDir();
    vi.mocked(readBoard).mockResolvedValue(makeBoard());
    vi.mocked(clusterDiff).mockReturnValue(null);

    const flow = makeSingleReviewFlow({
      states: {
        review: {
          type: "single",
          agent: "canon-reviewer",
          compete: {
            count: 3,
            strategy: "synthesize",
            lenses: ["speed", "safety", "simplicity"],
          },
        },
        done: { type: "terminal" },
      },
    });

    const result = await getSpawnPrompt({
      workspace,
      state_id: "review",
      flow,
      variables: { task: "review the PR" },
    });

    expect(result.prompts).toHaveLength(3);
    expect(result.fanned_out).toBe(true);
    expect(result.prompts[0].prompt).toContain("speed");
    expect(result.prompts[1].prompt).toContain("safety");
    expect(result.prompts[2].prompt).toContain("simplicity");
  });

  it("uses default auto compete expansion", async () => {
    const workspace = makeTmpDir();
    vi.mocked(readBoard).mockResolvedValue(makeBoard());
    vi.mocked(clusterDiff).mockReturnValue(null);

    const flow = makeSingleReviewFlow({
      states: {
        review: {
          type: "single",
          agent: "canon-reviewer",
          compete: "auto",
        },
        done: { type: "terminal" },
      },
    });

    const result = await getSpawnPrompt({
      workspace,
      state_id: "review",
      flow,
      variables: { task: "review the PR" },
    });

    expect(result.prompts).toHaveLength(3);
    expect(result.fanned_out).toBe(true);
  });
});
