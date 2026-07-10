import { getExecutionStore } from "@domains/workspaces/execution-store-cache.ts";

/**
 * Seed a minimal `execution` row on a temp-dir workspace so
 * `assertWorkspaceInitialized` (and any tool that gates on it) treats the
 * workspace as backed. Mirrors `record-agent-metrics.test.ts`'s
 * `setupWorkspace` fixture. Shared across all `write_*` tool test files so
 * each doesn't hand-roll its own copy.
 */
// canon:allow-unwired: test-only helper imported exclusively from *.test.ts files, which the dead-wire reachability grep excludes by design
export function seedExecution(workspace: string, stateId = "build"): void {
  const store = getExecutionStore(workspace);
  const now = new Date().toISOString();
  store.initExecution({
    base_commit: "abc123",
    branch: "feat/test",
    created: now,
    current_state: stateId,
    entry: stateId,
    flow: "test-flow",
    flow_name: "test-flow",
    last_updated: now,
    sanitized: "feat-test",
    slug: "test-slug",
    started: now,
    task: "test task",
    tier: "medium",
  });
}
