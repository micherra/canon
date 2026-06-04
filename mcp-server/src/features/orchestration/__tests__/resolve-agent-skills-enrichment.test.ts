/**
 * resolve-agent-skills area memory + hot-file enrichment integration tests.
 *
 * Tests for options.filePaths area memory and hot-file caution injection:
 * - Area memory section injected when observations exist for the subsystem
 * - Hot-file section injected when files have high build count
 * - Both sections absent when no data exists
 * - Fail-open: getDriftDb throws → preload_prompt still contains base content
 * - Without options.filePaths, no area/hot-file sections are added (existing behavior)
 * - Audit event area_enrichment_injected logged when enrichment data injected
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getExecutionStore } from "@domains/workspaces/execution-store-cache.ts";
import {
  type ResolveAgentSkillsResult,
  resolveAgentSkills,
} from "@features/orchestration/tools/resolve-agent-skills.ts";
import { getDriftDb } from "@platform/storage/drift/drift-db-cache.ts";
import { assertOk } from "@shared/lib/tool-result.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---- Mocks ----

vi.mock("@platform/storage/drift/drift-db-cache.ts", () => ({
  getDriftDb: vi.fn(),
}));

vi.mock("@domains/workspaces/execution-store-cache.ts", () => ({
  getExecutionStore: vi.fn(),
}));

// ---- Helpers ----

async function ok(
  result: ReturnType<typeof resolveAgentSkills>,
): Promise<{ ok: true } & ResolveAgentSkillsResult> {
  const resolved = await result;
  assertOk<ResolveAgentSkillsResult>(resolved);
  return resolved;
}

function seedPluginDir(): string {
  const pluginDir = mkdtempSync(join(tmpdir(), "canon-skills-enrichment-"));
  mkdirSync(join(pluginDir, "agents"));
  mkdirSync(join(pluginDir, "rules"));
  mkdirSync(join(pluginDir, "references"));
  mkdirSync(join(pluginDir, "primers"));
  mkdirSync(join(pluginDir, "templates"));
  return pluginDir;
}

function writeAgent(pluginDir: string, name: string, frontmatter: string, body = "body\n") {
  writeFileSync(join(pluginDir, "agents", `${name}.md`), `---\n${frontmatter}\n---\n\n${body}`);
}

/**
 * Build a mock DriftDb that returns the given area observations and flow runs.
 *
 * The mock wires up all three call paths used by area-memory-enrichment.ts
 * and hot-file-detection.ts:
 *   - getAreaMemory() → AreaMemoryDao with getObservationsForSubsystems + markInjected
 *   - getAllFlowRuns() → FlowRunEntry[]
 *   - getSignals() → { getFileViolationHistory, getErrorFixes } (for pitfall enrichment)
 */
function makeMockDriftDb({
  observations = [] as { subsystem_key: string; content: string; source: string }[],
  flowRuns = [] as {
    run_id: string;
    flow?: string;
    task?: string;
    completed: string;
    commits?: string[];
  }[],
} = {}) {
  const areaMemoryDao = {
    getObservationsForSubsystems: vi.fn((keys: string[]) => {
      return observations
        .filter((o) => keys.includes(o.subsystem_key))
        .map((o, i) => ({
          content: o.content,
          created_at: "2026-05-20T10:00:00.000Z",
          id: i + 1,
          injected_count: 0,
          last_injected_at: null,
          source: o.source,
          subsystem_key: o.subsystem_key,
          workflow_slug: null,
        }));
    }),
    markInjected: vi.fn(),
  };

  const mockSignals = {
    getErrorFixes: vi.fn(() => []),
    getFileViolationHistory: vi.fn(() => []),
  };

  return {
    getAreaMemory: vi.fn(() => areaMemoryDao),
    getAllFlowRuns: vi.fn(() => flowRuns),
    getSignals: vi.fn(() => mockSignals),
    _areaMemoryDao: areaMemoryDao,
  };
}

// A recent ISO timestamp that is always within the 14-day hot-file lookback window.
// Using Date.now() - 1 day avoids the stale-date flakiness that occurs when a
// hardcoded date drifts outside the window after 14 days.
const RECENT_COMPLETED = (() => {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString();
})();

// ---- Tests ----

describe("resolveAgentSkills — area memory and hot-file enrichment", () => {
  let pluginDir: string;
  let projectDir: string;

  beforeEach(() => {
    pluginDir = seedPluginDir();
    projectDir = mkdtempSync(join(tmpdir(), "canon-project-enrichment-"));
    writeAgent(pluginDir, "engineer", "name: engineer");
    vi.clearAllMocks();
  });

  afterEach(() => {
    rmSync(pluginDir, { force: true, recursive: true });
    rmSync(projectDir, { force: true, recursive: true });
  });

  // ---- Area memory section ----

  it("preload_prompt includes Area Memory section when observations exist for subsystem", async () => {
    const mockDb = makeMockDriftDb({
      observations: [
        {
          content: "Watch out for circular imports in orchestration",
          source: "reviewer",
          subsystem_key: "features/orchestration",
        },
      ],
    });
    vi.mocked(getDriftDb).mockReturnValue(mockDb as never);

    const result = await ok(
      resolveAgentSkills({ agent_name: "engineer" }, pluginDir, projectDir, {
        filePaths: ["mcp-server/src/features/orchestration/tools/resolve-agent-skills.ts"],
      }),
    );

    expect(result.preload_prompt).toContain("## Area Memory");
    expect(result.preload_prompt).toContain("Watch out for circular imports in orchestration");
    expect(result.preload_prompt).toContain("area: features/orchestration");
  });

  it("preload_prompt does NOT include Area Memory section when no observations exist", async () => {
    const mockDb = makeMockDriftDb({ observations: [] });
    vi.mocked(getDriftDb).mockReturnValue(mockDb as never);

    const result = await ok(
      resolveAgentSkills({ agent_name: "engineer" }, pluginDir, projectDir, {
        filePaths: ["mcp-server/src/features/orchestration/tools/resolve-agent-skills.ts"],
      }),
    );

    expect(result.preload_prompt).not.toContain("## Area Memory");
  });

  // ---- Hot-file section ----

  it("preload_prompt includes Hot-File Caution section when files appear in 3+ builds", async () => {
    const targetFile = "mcp-server/src/features/orchestration/tools/resolve-agent-skills.ts";

    // Seed 3 runs, each containing the target file
    const runs = Array.from({ length: 3 }, (_, i) => ({
      run_id: `run-${i + 1}`,
      flow: `build-${i + 1}`,
      completed: RECENT_COMPLETED,
      commits: [JSON.stringify({ sha: `abc${i}`, files: [targetFile] })],
    }));

    const mockDb = makeMockDriftDb({ flowRuns: runs });
    vi.mocked(getDriftDb).mockReturnValue(mockDb as never);

    const result = await ok(
      resolveAgentSkills({ agent_name: "engineer" }, pluginDir, projectDir, {
        filePaths: [targetFile],
      }),
    );

    expect(result.preload_prompt).toContain("## Hot-File Caution");
    expect(result.preload_prompt).toContain(targetFile);
    expect(result.preload_prompt).toContain("modified in 3 builds in the last 14 days");
  });

  it("preload_prompt does NOT include Hot-File Caution when file appears in fewer than 3 builds", async () => {
    const targetFile = "mcp-server/src/features/orchestration/tools/resolve-agent-skills.ts";

    // Only 2 runs
    const runs = Array.from({ length: 2 }, (_, i) => ({
      run_id: `run-${i + 1}`,
      flow: `build-${i + 1}`,
      completed: RECENT_COMPLETED,
      commits: [JSON.stringify({ sha: `abc${i}`, files: [targetFile] })],
    }));

    const mockDb = makeMockDriftDb({ flowRuns: runs });
    vi.mocked(getDriftDb).mockReturnValue(mockDb as never);

    const result = await ok(
      resolveAgentSkills({ agent_name: "engineer" }, pluginDir, projectDir, {
        filePaths: [targetFile],
      }),
    );

    expect(result.preload_prompt).not.toContain("## Hot-File Caution");
  });

  // ---- No filePaths — existing behavior preserved ----

  it("without options.filePaths, no area/hot-file sections are added", async () => {
    // getDriftDb should not even be called for area/hot-file when no filePaths
    const mockDb = makeMockDriftDb();
    vi.mocked(getDriftDb).mockReturnValue(mockDb as never);

    const result = await ok(resolveAgentSkills({ agent_name: "engineer" }, pluginDir, projectDir));

    expect(result.preload_prompt).not.toContain("## Area Memory");
    expect(result.preload_prompt).not.toContain("## Hot-File Caution");
  });

  it("with empty options.filePaths, no area/hot-file sections are added", async () => {
    const mockDb = makeMockDriftDb();
    vi.mocked(getDriftDb).mockReturnValue(mockDb as never);

    const result = await ok(
      resolveAgentSkills({ agent_name: "engineer" }, pluginDir, projectDir, { filePaths: [] }),
    );

    expect(result.preload_prompt).not.toContain("## Area Memory");
    expect(result.preload_prompt).not.toContain("## Hot-File Caution");
  });

  // ---- Fail-open behavior ----

  it("fail-open: getDriftDb throws for area memory, preload_prompt still has base content", async () => {
    vi.mocked(getDriftDb).mockImplementation(() => {
      throw new Error("drift.db not initialized");
    });

    const result = await ok(
      resolveAgentSkills({ agent_name: "engineer" }, pluginDir, projectDir, {
        filePaths: ["mcp-server/src/features/orchestration/tools/resolve-agent-skills.ts"],
      }),
    );

    // Should succeed — no area memory or hot-file caution sections
    expect(result.preload_prompt).not.toContain("## Area Memory");
    expect(result.preload_prompt).not.toContain("## Hot-File Caution");
    // agent_name still resolved correctly
    expect(result.agent_name).toBe("engineer");
  });

  it("fail-open: getAreaMemory throws, preload_prompt returned without Area Memory section", async () => {
    const mockDb = {
      getAreaMemory: vi.fn(() => {
        throw new Error("area_memory table missing");
      }),
      getAllFlowRuns: vi.fn(() => []),
      getSignals: vi.fn(() => ({
        getFileViolationHistory: vi.fn(() => []),
        getErrorFixes: vi.fn(() => []),
      })),
    };
    vi.mocked(getDriftDb).mockReturnValue(mockDb as never);

    const result = await ok(
      resolveAgentSkills({ agent_name: "engineer" }, pluginDir, projectDir, {
        filePaths: ["mcp-server/src/features/orchestration/tools/resolve-agent-skills.ts"],
      }),
    );

    expect(result.preload_prompt).not.toContain("## Area Memory");
    expect(result.agent_name).toBe("engineer");
  });

  // ---- Audit event logging ----

  it("logs area_enrichment_injected event when area memory data found and workspace provided", async () => {
    const mockAppendEvent = vi.fn();
    vi.mocked(getExecutionStore).mockReturnValue({ appendEvent: mockAppendEvent } as never);

    const targetFile = "mcp-server/src/features/orchestration/tools/resolve-agent-skills.ts";
    const mockDb = makeMockDriftDb({
      observations: [
        {
          content: "Watch for imports from orchestration",
          source: "reviewer",
          subsystem_key: "features/orchestration",
        },
      ],
    });
    vi.mocked(getDriftDb).mockReturnValue(mockDb as never);

    const workspace = "/fake/workspace";
    await ok(
      resolveAgentSkills({ agent_name: "engineer" }, pluginDir, projectDir, {
        filePaths: [targetFile],
        workspace,
      }),
    );

    expect(getExecutionStore).toHaveBeenCalledWith(workspace);
    expect(mockAppendEvent).toHaveBeenCalledWith(
      "area_enrichment_injected",
      expect.objectContaining({
        agent: "engineer",
        area_memory_count: expect.any(Number),
        hot_file_count: expect.any(Number),
        timestamp: expect.any(String),
      }),
    );
    const callArgs = mockAppendEvent.mock.calls.find(
      (call) => call[0] === "area_enrichment_injected",
    );
    expect(callArgs).toBeDefined();
    expect(callArgs![1].area_memory_count).toBeGreaterThan(0);
  });

  it("logs area_enrichment_injected event when hot-file data found and workspace provided", async () => {
    const mockAppendEvent = vi.fn();
    vi.mocked(getExecutionStore).mockReturnValue({ appendEvent: mockAppendEvent } as never);

    const targetFile = "mcp-server/src/features/orchestration/tools/resolve-agent-skills.ts";
    const runs = Array.from({ length: 3 }, (_, i) => ({
      run_id: `run-${i + 1}`,
      flow: `build-${i + 1}`,
      completed: RECENT_COMPLETED,
      commits: [JSON.stringify({ sha: `abc${i}`, files: [targetFile] })],
    }));

    const mockDb = makeMockDriftDb({ flowRuns: runs });
    vi.mocked(getDriftDb).mockReturnValue(mockDb as never);

    const workspace = "/fake/workspace";
    await ok(
      resolveAgentSkills({ agent_name: "engineer" }, pluginDir, projectDir, {
        filePaths: [targetFile],
        workspace,
      }),
    );

    expect(mockAppendEvent).toHaveBeenCalledWith(
      "area_enrichment_injected",
      expect.objectContaining({
        agent: "engineer",
        hot_file_count: expect.any(Number),
        timestamp: expect.any(String),
      }),
    );
    const callArgs = mockAppendEvent.mock.calls.find(
      (call) => call[0] === "area_enrichment_injected",
    );
    expect(callArgs![1].hot_file_count).toBeGreaterThan(0);
  });

  it("audit event NOT logged when no area memory or hot-file data found", async () => {
    const mockAppendEvent = vi.fn();
    vi.mocked(getExecutionStore).mockReturnValue({ appendEvent: mockAppendEvent } as never);

    const mockDb = makeMockDriftDb({ observations: [], flowRuns: [] });
    vi.mocked(getDriftDb).mockReturnValue(mockDb as never);

    await ok(
      resolveAgentSkills({ agent_name: "engineer" }, pluginDir, projectDir, {
        filePaths: ["mcp-server/src/features/orchestration/tools/resolve-agent-skills.ts"],
        workspace: "/fake/workspace",
      }),
    );

    // area_enrichment_injected should NOT be called when counts are both 0
    const areaEnrichmentCalls = mockAppendEvent.mock.calls.filter(
      (call) => call[0] === "area_enrichment_injected",
    );
    expect(areaEnrichmentCalls).toHaveLength(0);
  });

  it("audit event NOT logged when workspace not provided", async () => {
    const mockAppendEvent = vi.fn();
    vi.mocked(getExecutionStore).mockReturnValue({ appendEvent: mockAppendEvent } as never);

    const mockDb = makeMockDriftDb({
      observations: [
        {
          content: "Some observation",
          source: "reviewer",
          subsystem_key: "features/orchestration",
        },
      ],
    });
    vi.mocked(getDriftDb).mockReturnValue(mockDb as never);

    // No workspace in options
    await ok(
      resolveAgentSkills({ agent_name: "engineer" }, pluginDir, projectDir, {
        filePaths: ["mcp-server/src/features/orchestration/tools/resolve-agent-skills.ts"],
      }),
    );

    const areaEnrichmentCalls = mockAppendEvent.mock.calls.filter(
      (call) => call[0] === "area_enrichment_injected",
    );
    expect(areaEnrichmentCalls).toHaveLength(0);
  });

  it("audit logging fail-open: getExecutionStore throws, sections still included in prompt", async () => {
    vi.mocked(getExecutionStore).mockImplementation(() => {
      throw new Error("store not available");
    });

    const mockDb = makeMockDriftDb({
      observations: [
        {
          content: "Some observation",
          source: "reviewer",
          subsystem_key: "features/orchestration",
        },
      ],
    });
    vi.mocked(getDriftDb).mockReturnValue(mockDb as never);

    const result = await ok(
      resolveAgentSkills({ agent_name: "engineer" }, pluginDir, projectDir, {
        filePaths: ["mcp-server/src/features/orchestration/tools/resolve-agent-skills.ts"],
        workspace: "/fake/workspace",
      }),
    );

    // Area memory section still in prompt even if audit fails
    expect(result.preload_prompt).toContain("## Area Memory");
    expect(result.preload_prompt).toContain("Some observation");
  });

  // ---- Section ordering ----

  it("area memory section comes after pitfalls section in preload_prompt", async () => {
    const targetFile = "mcp-server/src/features/orchestration/tools/resolve-agent-skills.ts";

    const mockSignals = {
      getErrorFixes: vi.fn(() => []),
      getFileViolationHistory: vi.fn(() => [
        {
          file_path: targetFile,
          first_seen: "2026-05-01",
          last_seen: "2026-05-20",
          principle_id: "simplicity-first",
          violation_count: 3,
        },
      ]),
    };

    const mockDb = makeMockDriftDb({
      observations: [
        {
          content: "Watch for complexity creep",
          source: "reviewer",
          subsystem_key: "features/orchestration",
        },
      ],
    });
    // Override getSignals to return our pitfall data
    (mockDb as Record<string, unknown>).getSignals = vi.fn(() => mockSignals);
    vi.mocked(getDriftDb).mockReturnValue(mockDb as never);

    const result = await ok(
      resolveAgentSkills({ agent_name: "engineer" }, pluginDir, projectDir, {
        filePaths: [targetFile],
      }),
    );

    const pitfallIdx = result.preload_prompt.indexOf("Known Pitfalls");
    const areaMemoryIdx = result.preload_prompt.indexOf("## Area Memory");

    // Both sections present
    expect(pitfallIdx).toBeGreaterThanOrEqual(0);
    expect(areaMemoryIdx).toBeGreaterThanOrEqual(0);
    // Area memory comes after pitfalls
    expect(areaMemoryIdx).toBeGreaterThan(pitfallIdx);
  });
});
