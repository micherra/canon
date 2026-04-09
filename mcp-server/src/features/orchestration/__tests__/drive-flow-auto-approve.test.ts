/**
 * drive-flow-auto-approve.test.ts — Settings injection integration tests.
 *
 * Tests that `injectSettingsIntoRequests` (exported from drive-flow.ts) correctly
 * delegates to `injectWorktreeSettings` for spawn requests that qualify for
 * auto-approval (permission_mode === "auto" and worktree_path set).
 *
 * Covers:
 * - Wave worktree requests with permission_mode "auto" trigger settings injection
 * - Multiple requests each get their own injection call
 * - Settings injection is skipped when permission_mode is "prompt"
 * - Settings injection is skipped when worktree_path is absent
 * - Settings injection is skipped when tools is absent
 * - Settings injection failure (returns false) does not throw — fail-closed
 * - Re-spawned wave tasks get settings injection for newly created worktrees
 * - Settings file contents match the expected tools for the agent type
 */

import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { injectSettingsIntoRequests } from "../tools/drive-flow.ts";
import type { SpawnRequest } from "../services/drive-flow-types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAutoRequest(overrides: Partial<SpawnRequest> = {}): SpawnRequest {
  return {
    agent_type: "canon:canon-implementor",
    isolation: "none",
    permission_mode: "auto",
    prompt: "Implement the task",
    tools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "NotebookEdit"],
    worktree_path: "/tmp/fake-worktree",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// injectSettingsIntoRequests — unit tests with mocked injectWorktreeSettings
// ---------------------------------------------------------------------------

describe("injectSettingsIntoRequests — conditional injection logic", () => {
  it("calls injectWorktreeSettings for each auto-mode request with worktree_path and tools", async () => {
    // Use actual filesystem — temp dirs are created by the caller of injectSettingsIntoRequests
    // in wave lifecycle. Here we just verify the function doesn't throw on valid input.
    // We need real temp dirs since injectWorktreeSettings is the real implementation.
    const dir1 = await mkdtemp(join(tmpdir(), "auto-approve-test-"));
    const dir2 = await mkdtemp(join(tmpdir(), "auto-approve-test-"));

    const requests: SpawnRequest[] = [
      makeAutoRequest({ worktree_path: dir1, tools: ["Read", "Bash"] }),
      makeAutoRequest({ worktree_path: dir2, tools: ["Read", "Edit", "Write"] }),
    ];

    // Should not throw
    await expect(injectSettingsIntoRequests(requests)).resolves.toBeUndefined();

    // Verify both files were written
    const settings1 = JSON.parse(
      await readFile(join(dir1, ".claude", "settings.local.json"), "utf8"),
    );
    const settings2 = JSON.parse(
      await readFile(join(dir2, ".claude", "settings.local.json"), "utf8"),
    );
    expect(settings1.permissions.allow).toEqual(["Read", "Bash"]);
    expect(settings2.permissions.allow).toEqual(["Read", "Edit", "Write"]);
  });

  it("skips injection when permission_mode is 'prompt'", async () => {
    const dir = await mkdtemp(join(tmpdir(), "auto-approve-test-"));

    const requests: SpawnRequest[] = [
      makeAutoRequest({ permission_mode: "prompt", worktree_path: dir }),
    ];

    await expect(injectSettingsIntoRequests(requests)).resolves.toBeUndefined();

    // settings.local.json should NOT have been created
    const settingsPath = join(dir, ".claude", "settings.local.json");
    await expect(readFile(settingsPath, "utf8")).rejects.toThrow();
  });

  it("skips injection when worktree_path is absent", async () => {
    // If worktree_path is absent, there's nowhere to write settings — skip
    const requests: SpawnRequest[] = [
      {
        agent_type: "canon:canon-implementor",
        isolation: "worktree",
        permission_mode: "auto",
        prompt: "Implement",
        tools: ["Read", "Bash"],
        // no worktree_path
      },
    ];

    await expect(injectSettingsIntoRequests(requests)).resolves.toBeUndefined();
    // No assertion on filesystem — nothing should have been written
  });

  it("skips injection when tools is absent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "auto-approve-test-"));

    const requests: SpawnRequest[] = [
      {
        agent_type: "canon:canon-implementor",
        isolation: "none",
        permission_mode: "auto",
        prompt: "Implement",
        worktree_path: dir,
        // no tools
      },
    ];

    await expect(injectSettingsIntoRequests(requests)).resolves.toBeUndefined();

    // settings.local.json should NOT have been created
    const settingsPath = join(dir, ".claude", "settings.local.json");
    await expect(readFile(settingsPath, "utf8")).rejects.toThrow();
  });

  it("does not throw when injection fails (fail-closed principle)", async () => {
    // Pass an invalid path — injectWorktreeSettings returns false but does not throw
    const requests: SpawnRequest[] = [
      makeAutoRequest({ worktree_path: "/dev/null/invalid-worktree" }),
    ];

    // Should resolve (not reject) even though injection will fail
    await expect(injectSettingsIntoRequests(requests)).resolves.toBeUndefined();
  });

  it("handles empty requests array without error", async () => {
    await expect(injectSettingsIntoRequests([])).resolves.toBeUndefined();
  });

  it("injects for auto-mode requests and skips prompt-mode requests in a mixed array", async () => {
    const dir1 = await mkdtemp(join(tmpdir(), "auto-approve-test-"));
    const dir2 = await mkdtemp(join(tmpdir(), "auto-approve-test-"));

    const requests: SpawnRequest[] = [
      makeAutoRequest({ permission_mode: "auto", worktree_path: dir1, tools: ["Read"] }),
      makeAutoRequest({ permission_mode: "prompt", worktree_path: dir2, tools: ["Read", "Bash"] }),
    ];

    await injectSettingsIntoRequests(requests);

    // dir1 should have settings (auto mode)
    const settings1 = JSON.parse(
      await readFile(join(dir1, ".claude", "settings.local.json"), "utf8"),
    );
    expect(settings1.permissions.allow).toEqual(["Read"]);

    // dir2 should NOT have settings (prompt mode)
    const settingsPath2 = join(dir2, ".claude", "settings.local.json");
    await expect(readFile(settingsPath2, "utf8")).rejects.toThrow();
  });

  it("subsequent injection into same worktree is idempotent (second call wins)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "auto-approve-test-"));

    const requests1: SpawnRequest[] = [
      makeAutoRequest({ worktree_path: dir, tools: ["Read", "Bash"] }),
    ];
    const requests2: SpawnRequest[] = [
      makeAutoRequest({ worktree_path: dir, tools: ["Read"] }),
    ];

    await injectSettingsIntoRequests(requests1);
    await injectSettingsIntoRequests(requests2);

    // Second write wins
    const settings = JSON.parse(
      await readFile(join(dir, ".claude", "settings.local.json"), "utf8"),
    );
    expect(settings.permissions.allow).toEqual(["Read"]);
  });
});

// ---------------------------------------------------------------------------
// Settings file contents match expected tools for agent type
// ---------------------------------------------------------------------------

describe("injectSettingsIntoRequests — settings file contents for known agent types", () => {
  it("writes correct built-in tools for implementor profile", async () => {
    const dir = await mkdtemp(join(tmpdir(), "auto-approve-test-"));
    // Implementor profile tools (from tool-profiles.ts) — MCP tools will be filtered out
    const implementorTools = [
      "Read",
      "Grep",
      "Glob",
      "Bash",
      "Edit",
      "Write",
      "NotebookEdit",
      "write_implementation_summary",
      "post_message",
      "get_messages",
      "graph_query",
    ];

    const requests: SpawnRequest[] = [
      makeAutoRequest({ worktree_path: dir, tools: implementorTools }),
    ];

    await injectSettingsIntoRequests(requests);

    const settings = JSON.parse(
      await readFile(join(dir, ".claude", "settings.local.json"), "utf8"),
    );
    // Only built-in tools — MCP tools (write_implementation_summary, post_message, etc.) excluded
    expect(settings.permissions.allow).toEqual([
      "Read",
      "Grep",
      "Glob",
      "Bash",
      "Edit",
      "Write",
      "NotebookEdit",
    ]);
  });

  it("writes correct built-in tools for researcher profile (includes WebFetch)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "auto-approve-test-"));
    const researcherTools = [
      "Read",
      "Grep",
      "Glob",
      "Bash",
      "WebFetch",
      "graph_query",
      "get_file_context",
      "semantic_search",
      "codebase_graph",
      "write_research_synthesis",
    ];

    const requests: SpawnRequest[] = [
      makeAutoRequest({ agent_type: "canon:canon-researcher", worktree_path: dir, tools: researcherTools }),
    ];

    await injectSettingsIntoRequests(requests);

    const settings = JSON.parse(
      await readFile(join(dir, ".claude", "settings.local.json"), "utf8"),
    );
    expect(settings.permissions.allow).toContain("WebFetch");
    expect(settings.permissions.allow).toContain("Read");
    expect(settings.permissions.allow).not.toContain("graph_query");
    expect(settings.permissions.allow).not.toContain("write_research_synthesis");
  });

  it("writes empty allow array for agent with no built-in tools", async () => {
    const dir = await mkdtemp(join(tmpdir(), "auto-approve-test-"));
    // Tools list with only MCP tools (no built-in tools)
    const mcpOnlyTools = ["graph_query", "semantic_search", "get_file_context"];

    const requests: SpawnRequest[] = [
      makeAutoRequest({ worktree_path: dir, tools: mcpOnlyTools }),
    ];

    await injectSettingsIntoRequests(requests);

    const settings = JSON.parse(
      await readFile(join(dir, ".claude", "settings.local.json"), "utf8"),
    );
    // Fail-closed: empty allow array means no extra permissions
    expect(settings.permissions.allow).toEqual([]);
  });
});
