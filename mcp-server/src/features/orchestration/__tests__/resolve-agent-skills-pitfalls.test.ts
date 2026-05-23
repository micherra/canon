/**
 * resolve-agent-skills pitfall injection tests.
 *
 * Tests for the options.filePaths pitfall enrichment feature:
 * - When filePaths provided, drift and error-fix pitfalls are appended
 * - Pitfalls section appears after corrections in preload_prompt
 * - Fail-open: enrichment errors produce empty string, never block spawn
 * - No pitfalls = no section appended
 * - Audit event logged to execution store when pitfalls injected + workspace given
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getExecutionStore } from "@domains/workspaces/execution-store-cache.ts";
import {
  type ResolveAgentSkillsResult,
  resolveAgentSkills,
} from "@features/orchestration/tools/resolve-agent-skills.ts";
import { getDriftDb } from "@platform/storage/drift/drift-db.ts";
import { assertOk } from "@shared/lib/tool-result.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---- Mocks ----

vi.mock("@platform/storage/drift/drift-db.ts", () => ({
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
  const pluginDir = mkdtempSync(join(tmpdir(), "canon-skills-pitfalls-"));
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

function makeMockDriftDbSignals(
  fileViolationRows: {
    file_path: string;
    first_seen: string;
    last_seen: string;
    principle_id: string;
    violation_count: number;
  }[],
  errorFixRows: {
    error_pattern: string;
    file_path: string;
    first_seen: string;
    fix_pattern: string;
    id: number;
    last_seen: string;
    occurrences: number;
    principle_id: string;
  }[],
) {
  return {
    getErrorFixes: vi.fn((_filePaths: string[]) => errorFixRows),
    getFileViolationHistory: vi.fn((_filePaths: string[]) => fileViolationRows),
  };
}

// ---- Tests ----

describe("resolveAgentSkills — pitfall injection", () => {
  let pluginDir: string;
  let projectDir: string;

  beforeEach(() => {
    pluginDir = seedPluginDir();
    projectDir = mkdtempSync(join(tmpdir(), "canon-project-pitfalls-"));
    writeAgent(pluginDir, "engineer", "name: engineer");
    vi.clearAllMocks();
  });

  afterEach(() => {
    rmSync(pluginDir, { force: true, recursive: true });
    rmSync(projectDir, { force: true, recursive: true });
  });

  it("without options.filePaths, does not call getDriftDb", async () => {
    await ok(resolveAgentSkills({ agent_name: "engineer" }, pluginDir, projectDir));
    expect(getDriftDb).not.toHaveBeenCalled();
  });

  it("with empty options.filePaths, does not call getDriftDb", async () => {
    await ok(
      resolveAgentSkills({ agent_name: "engineer" }, pluginDir, projectDir, { filePaths: [] }),
    );
    expect(getDriftDb).not.toHaveBeenCalled();
  });

  it("with filePaths and no pitfall data returns preload_prompt without pitfalls section", async () => {
    const mockSignals = makeMockDriftDbSignals([], []);
    vi.mocked(getDriftDb).mockReturnValue({ getSignals: () => mockSignals } as never);

    const result = await ok(
      resolveAgentSkills({ agent_name: "engineer" }, pluginDir, projectDir, {
        filePaths: ["src/foo.ts"],
      }),
    );

    expect(result.preload_prompt).not.toContain("Known Pitfalls");
  });

  it("with filePaths and drift pitfalls, appends Known Pitfalls section to preload_prompt", async () => {
    const mockSignals = makeMockDriftDbSignals(
      [
        {
          file_path: "src/foo.ts",
          first_seen: "2026-05-01",
          last_seen: "2026-05-20",
          principle_id: "simplicity-first",
          violation_count: 3,
        },
        {
          file_path: "src/foo.ts",
          first_seen: "2026-05-01",
          last_seen: "2026-05-20",
          principle_id: "simplicity-first",
          violation_count: 3,
        },
      ],
      [],
    );
    vi.mocked(getDriftDb).mockReturnValue({ getSignals: () => mockSignals } as never);

    const result = await ok(
      resolveAgentSkills({ agent_name: "engineer" }, pluginDir, projectDir, {
        filePaths: ["src/foo.ts"],
      }),
    );

    expect(result.preload_prompt).toContain("Known Pitfalls");
    expect(result.preload_prompt).toContain("Drift Signals");
    expect(result.preload_prompt).toContain("simplicity-first");
    expect(result.preload_prompt).toContain("src/foo.ts");
  });

  it("with filePaths and error-fix pitfalls, appends Prior Error→Fix Pairs section", async () => {
    const mockSignals = makeMockDriftDbSignals(
      [],
      [
        {
          error_pattern: "throwing instead of returning error",
          file_path: "src/bar.ts",
          first_seen: "2026-05-10",
          fix_pattern: "return toolError(...)",
          id: 1,
          last_seen: "2026-05-19",
          occurrences: 2,
          principle_id: "errors-are-values",
        },
      ],
    );
    vi.mocked(getDriftDb).mockReturnValue({ getSignals: () => mockSignals } as never);

    const result = await ok(
      resolveAgentSkills({ agent_name: "engineer" }, pluginDir, projectDir, {
        filePaths: ["src/bar.ts"],
      }),
    );

    expect(result.preload_prompt).toContain("Known Pitfalls");
    expect(result.preload_prompt).toContain("Prior Error");
    expect(result.preload_prompt).toContain("throwing instead of returning error");
    expect(result.preload_prompt).toContain("return toolError");
  });

  it("pitfalls section appended after corrections section", async () => {
    // Set up corrections directory
    const correctionsDir = join(projectDir, ".canon", "corrections");
    mkdirSync(correctionsDir, { recursive: true });
    writeFileSync(
      join(correctionsDir, "c1.json"),
      JSON.stringify({
        agent_type: "engineer",
        commit_sha: "abc12345def",
        commit_subject: "feat: something",
        correction_command: "git commit --amend",
        file_path: "src/foo.ts",
        timestamp: new Date().toISOString(),
      }),
    );

    const mockSignals = makeMockDriftDbSignals(
      [
        {
          file_path: "src/foo.ts",
          first_seen: "2026-05-01",
          last_seen: "2026-05-20",
          principle_id: "simplicity-first",
          violation_count: 3,
        },
      ],
      [],
    );
    vi.mocked(getDriftDb).mockReturnValue({ getSignals: () => mockSignals } as never);

    const result = await ok(
      resolveAgentSkills({ agent_name: "engineer" }, pluginDir, projectDir, {
        filePaths: ["src/foo.ts"],
      }),
    );

    const corrIdx = result.preload_prompt.indexOf("Recent User Corrections");
    const pitfallIdx = result.preload_prompt.indexOf("Known Pitfalls");
    // corrections section present
    expect(corrIdx).toBeGreaterThanOrEqual(0);
    // pitfalls section present and comes after corrections
    expect(pitfallIdx).toBeGreaterThan(corrIdx);
  });

  it("fail-open: getDriftDb throws, preload_prompt returned without pitfalls section", async () => {
    vi.mocked(getDriftDb).mockImplementation(() => {
      throw new Error("drift.db not initialized");
    });

    const result = await ok(
      resolveAgentSkills({ agent_name: "engineer" }, pluginDir, projectDir, {
        filePaths: ["src/foo.ts"],
      }),
    );

    // Should still succeed
    expect(result.preload_prompt).not.toContain("Known Pitfalls");
  });

  it("fail-open: getSignals throws, preload_prompt returned without pitfalls section", async () => {
    vi.mocked(getDriftDb).mockReturnValue({
      getSignals: () => {
        throw new Error("signals not available");
      },
    } as never);

    const result = await ok(
      resolveAgentSkills({ agent_name: "engineer" }, pluginDir, projectDir, {
        filePaths: ["src/foo.ts"],
      }),
    );

    expect(result.preload_prompt).not.toContain("Known Pitfalls");
  });

  it("audit event logged when pitfalls are injected and workspace is provided", async () => {
    const mockAppendEvent = vi.fn();
    vi.mocked(getExecutionStore).mockReturnValue({
      appendEvent: mockAppendEvent,
    } as never);

    const mockSignals = makeMockDriftDbSignals(
      [
        {
          file_path: "src/foo.ts",
          first_seen: "2026-05-01",
          last_seen: "2026-05-20",
          principle_id: "simplicity-first",
          violation_count: 3,
        },
      ],
      [],
    );
    vi.mocked(getDriftDb).mockReturnValue({ getSignals: () => mockSignals } as never);

    const workspace = "/fake/workspace";
    await ok(
      resolveAgentSkills({ agent_name: "engineer" }, pluginDir, projectDir, {
        filePaths: ["src/foo.ts"],
        workspace,
      }),
    );

    expect(getExecutionStore).toHaveBeenCalledWith(workspace);
    expect(mockAppendEvent).toHaveBeenCalledWith(
      "pitfall_injected",
      expect.objectContaining({
        agent: "engineer",
        pitfall_count: expect.any(Number),
        timestamp: expect.any(String),
      }),
    );
  });

  it("audit event NOT logged when no pitfalls found (pitfall_count=0)", async () => {
    const mockAppendEvent = vi.fn();
    vi.mocked(getExecutionStore).mockReturnValue({
      appendEvent: mockAppendEvent,
    } as never);

    const mockSignals = makeMockDriftDbSignals([], []);
    vi.mocked(getDriftDb).mockReturnValue({ getSignals: () => mockSignals } as never);

    await ok(
      resolveAgentSkills({ agent_name: "engineer" }, pluginDir, projectDir, {
        filePaths: ["src/foo.ts"],
        workspace: "/fake/workspace",
      }),
    );

    expect(mockAppendEvent).not.toHaveBeenCalled();
  });

  it("audit event NOT logged when workspace not provided", async () => {
    const mockAppendEvent = vi.fn();
    vi.mocked(getExecutionStore).mockReturnValue({
      appendEvent: mockAppendEvent,
    } as never);

    const mockSignals = makeMockDriftDbSignals(
      [
        {
          file_path: "src/foo.ts",
          first_seen: "2026-05-01",
          last_seen: "2026-05-20",
          principle_id: "simplicity-first",
          violation_count: 3,
        },
      ],
      [],
    );
    vi.mocked(getDriftDb).mockReturnValue({ getSignals: () => mockSignals } as never);

    // No workspace in options
    await ok(
      resolveAgentSkills({ agent_name: "engineer" }, pluginDir, projectDir, {
        filePaths: ["src/foo.ts"],
      }),
    );

    expect(mockAppendEvent).not.toHaveBeenCalled();
  });

  it("audit logging fail-open: getExecutionStore throws, pitfalls still included in prompt", async () => {
    vi.mocked(getExecutionStore).mockImplementation(() => {
      throw new Error("store not available");
    });

    const mockSignals = makeMockDriftDbSignals(
      [
        {
          file_path: "src/foo.ts",
          first_seen: "2026-05-01",
          last_seen: "2026-05-20",
          principle_id: "simplicity-first",
          violation_count: 3,
        },
      ],
      [],
    );
    vi.mocked(getDriftDb).mockReturnValue({ getSignals: () => mockSignals } as never);

    const result = await ok(
      resolveAgentSkills({ agent_name: "engineer" }, pluginDir, projectDir, {
        filePaths: ["src/foo.ts"],
        workspace: "/fake/workspace",
      }),
    );

    // Pitfalls still in prompt even if audit fails
    expect(result.preload_prompt).toContain("Known Pitfalls");
  });

  it("backward compatible: existing callers without options param get same result", async () => {
    const withoutOptions = await ok(resolveAgentSkills({ agent_name: "engineer" }, pluginDir));
    // No drift db calls for callers without options
    expect(getDriftDb).not.toHaveBeenCalled();
    expect(withoutOptions.preload_prompt).toBe("");
  });
});
