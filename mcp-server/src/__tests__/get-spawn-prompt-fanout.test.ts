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

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Hoist mocks before module import

vi.mock("../orchestration/wave-briefing.ts", () => ({
  assembleWaveBriefing: vi.fn().mockReturnValue(undefined),
  readWaveGuidance: vi.fn().mockResolvedValue(""),
}));

vi.mock("../orchestration/diff-cluster.ts", () => ({
  clusterDiff: vi.fn(),
}));

import type { FileCluster } from "../orchestration/diff-cluster.ts";
import { clusterDiff } from "../orchestration/diff-cluster.ts";
import type { Board, ResolvedFlow } from "../orchestration/flow-schema.ts";
import { getSpawnPrompt } from "../tools/get-spawn-prompt.ts";

const mockBoard: Board = {
  base_commit: "abc1234",
  blocked: null,
  concerns: [],
  current_state: "review",
  entry: "review",
  flow: "test",
  iterations: {},
  last_updated: new Date().toISOString(),
  skipped: [],
  started: new Date().toISOString(),
  states: {},
  task: "test",
};

let tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "gsp-fanout-test-"));
  tmpDirs.push(dir);
  return dir;
}

function makeSingleReviewFlow(overrides: Partial<ResolvedFlow> = {}): ResolvedFlow {
  return {
    description: "Test review flow",
    entry: "review",
    name: "test-review-flow",
    spawn_instructions: {
      review: "Review cluster ${item.cluster_key} files: ${item.files} (${item.file_count} files)",
    },
    states: {
      done: { type: "terminal" },
      review: {
        agent: "canon-reviewer",
        large_diff_threshold: 5,
        type: "single",
      },
    },
    ...overrides,
  };
}

const sampleClusters: FileCluster[] = [
  { files: ["src/api/orders.ts", "src/api/users.ts"], key: "src/api" },
  {
    files: ["src/ui/Dashboard.svelte", "src/ui/Sidebar.svelte", "src/ui/Header.svelte"],
    key: "src/ui",
  },
];

afterEach(() => {
  for (const d of tmpDirs) {
    rmSync(d, { force: true, recursive: true });
  }
  tmpDirs = [];
  vi.clearAllMocks();
});

// Fan-out when clusters are present

describe("getSpawnPrompt — single state fan-out with clusters", () => {
  it("produces one prompt per cluster when clusters are present", async () => {
    const workspace = makeTmpDir();
    vi.mocked(clusterDiff).mockReturnValue(sampleClusters);

    const flow = makeSingleReviewFlow();
    const result = await getSpawnPrompt({
      _board: mockBoard,
      flow,
      state_id: "review",
      variables: { task: "review the PR" },
      workspace,
    });

    expect(result.prompts).toHaveLength(sampleClusters.length);
  });

  it("sets fanned_out to true when clusters expand a single state", async () => {
    const workspace = makeTmpDir();
    vi.mocked(clusterDiff).mockReturnValue(sampleClusters);

    const flow = makeSingleReviewFlow();
    const result = await getSpawnPrompt({
      _board: mockBoard,
      flow,
      state_id: "review",
      variables: { task: "review the PR" },
      workspace,
    });

    expect(result.fanned_out).toBe(true);
  });

  it("each prompt is scoped to its cluster with correct item substitution", async () => {
    const workspace = makeTmpDir();
    vi.mocked(clusterDiff).mockReturnValue(sampleClusters);

    const flow = makeSingleReviewFlow();
    const result = await getSpawnPrompt({
      _board: mockBoard,
      flow,
      state_id: "review",
      variables: { task: "review the PR" },
      workspace,
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
    vi.mocked(clusterDiff).mockReturnValue(sampleClusters);

    const flow = makeSingleReviewFlow();
    const result = await getSpawnPrompt({
      _board: mockBoard,
      flow,
      state_id: "review",
      variables: { task: "review the PR" },
      workspace,
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
    vi.mocked(clusterDiff).mockReturnValue(sampleClusters);

    const flow = makeSingleReviewFlow();
    const result = await getSpawnPrompt({
      _board: mockBoard,
      flow,
      state_id: "review",
      variables: {},
      workspace,
    });

    for (const entry of result.prompts) {
      expect(entry.agent).toBe("canon-reviewer");
    }
  });

  it("applies template_paths to every cluster prompt", async () => {
    const workspace = makeTmpDir();
    vi.mocked(clusterDiff).mockReturnValue(sampleClusters);

    const flow = makeSingleReviewFlow({
      states: {
        done: { type: "terminal" },
        review: {
          agent: "canon-reviewer",
          large_diff_threshold: 5,
          template: "review-template",
          type: "single",
        },
      },
    });

    const result = await getSpawnPrompt({
      _board: mockBoard,
      flow,
      state_id: "review",
      variables: { CANON_PLUGIN_ROOT: "/plugin", task: "test" },
      workspace,
    });

    expect(result.prompts).toHaveLength(sampleClusters.length);
    for (const entry of result.prompts) {
      expect(entry.template_paths).toEqual(["/plugin/templates/review-template.md"]);
    }
  });

  it("role substitution applies to all fanned-out single prompts", async () => {
    const workspace = makeTmpDir();
    vi.mocked(clusterDiff).mockReturnValue(sampleClusters);

    const flow = makeSingleReviewFlow({
      spawn_instructions: {
        review: "As ${role}, review cluster ${item.cluster_key}: ${item.files}",
      },
    });

    const result = await getSpawnPrompt({
      _board: mockBoard,
      flow,
      role: "security-reviewer",
      state_id: "review",
      variables: {},
      workspace,
    });

    expect(result.prompts).toHaveLength(sampleClusters.length);
    for (const entry of result.prompts) {
      expect(entry.prompt).toContain("security-reviewer");
      expect(entry.role).toBe("security-reviewer");
    }
  });
});

// No fan-out when clusters are absent

describe("getSpawnPrompt — single state without clusters (no fan-out)", () => {
  it("produces exactly one prompt when clusters are null (below threshold)", async () => {
    const workspace = makeTmpDir();
    vi.mocked(clusterDiff).mockReturnValue(null);

    const flow = makeSingleReviewFlow({
      spawn_instructions: { review: "Review all the files." },
    });

    const result = await getSpawnPrompt({
      _board: mockBoard,
      flow,
      state_id: "review",
      variables: {},
      workspace,
    });

    expect(result.prompts).toHaveLength(1);
  });

  it("fanned_out is absent when no fan-out happens (null clusters)", async () => {
    const workspace = makeTmpDir();
    vi.mocked(clusterDiff).mockReturnValue(null);

    const flow = makeSingleReviewFlow();
    const result = await getSpawnPrompt({
      _board: mockBoard,
      flow,
      state_id: "review",
      variables: {},
      workspace,
    });

    expect(result.fanned_out).toBeUndefined();
  });

  it("fanned_out is absent for single state with no large_diff_threshold", async () => {
    const workspace = makeTmpDir();
    // clusterDiff should not be called since no large_diff_threshold set
    vi.mocked(clusterDiff).mockReturnValue(null);

    const flow: ResolvedFlow = {
      description: "Test",
      entry: "review",
      name: "test-flow",
      spawn_instructions: { review: "Review everything." },
      states: {
        done: { type: "terminal" },
        review: { agent: "canon-reviewer", type: "single" },
      },
    };

    const result = await getSpawnPrompt({
      flow,
      state_id: "review",
      variables: {},
      workspace,
    });

    expect(result.prompts).toHaveLength(1);
    expect(result.fanned_out).toBeUndefined();
  });

  it("produces exactly one prompt when clusters is empty array (edge case)", async () => {
    const workspace = makeTmpDir();
    // clusterDiff returns empty array (unusual but possible)
    vi.mocked(clusterDiff).mockReturnValue([]);

    const flow = makeSingleReviewFlow();
    const result = await getSpawnPrompt({
      _board: mockBoard,
      flow,
      state_id: "review",
      variables: {},
      workspace,
    });

    // Empty clusters array should fall through to single prompt
    expect(result.prompts).toHaveLength(1);
    expect(result.fanned_out).toBeUndefined();
  });
});

describe("getSpawnPrompt — compete expansion", () => {
  it("expands a single state into multiple prompts when compete is configured", async () => {
    const workspace = makeTmpDir();
    vi.mocked(clusterDiff).mockReturnValue(null);

    const flow = makeSingleReviewFlow({
      states: {
        done: { type: "terminal" },
        review: {
          agent: "canon-reviewer",
          compete: {
            count: 3,
            lenses: ["speed", "safety", "simplicity"],
            strategy: "synthesize",
          },
          type: "single",
        },
      },
    });

    const result = await getSpawnPrompt({
      _board: mockBoard,
      flow,
      state_id: "review",
      variables: { task: "review the PR" },
      workspace,
    });

    expect(result.prompts).toHaveLength(3);
    expect(result.fanned_out).toBe(true);
    expect(result.prompts[0].prompt).toContain("speed");
    expect(result.prompts[1].prompt).toContain("safety");
    expect(result.prompts[2].prompt).toContain("simplicity");
  });

  it("uses default auto compete expansion", async () => {
    const workspace = makeTmpDir();
    vi.mocked(clusterDiff).mockReturnValue(null);

    const flow = makeSingleReviewFlow({
      states: {
        done: { type: "terminal" },
        review: {
          agent: "canon-reviewer",
          compete: "auto",
          type: "single",
        },
      },
    });

    const result = await getSpawnPrompt({
      _board: mockBoard,
      flow,
      state_id: "review",
      variables: { task: "review the PR" },
      workspace,
    });

    expect(result.prompts).toHaveLength(3);
    expect(result.fanned_out).toBe(true);
  });
});
