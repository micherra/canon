import { getExecutionStore } from "@domains/workspaces/execution-store-cache.ts";
import type { CanonToolError } from "@shared/lib/tool-result.ts";
import { toolError } from "@shared/lib/tool-result.ts";
import { normalizeWorkspaceRoot } from "./write-receipt.ts";

/**
 * Fail-closed guard mirroring `record_agent_metrics`: returns a
 * WORKSPACE_NOT_FOUND `CanonToolError` when `workspace` does not resolve to
 * an initialized execution store, or `null` when the workspace is backed.
 * Resolves the SAME store root the write receipt / ADR-0043 completion gate
 * use (`normalizeWorkspaceRoot`), so validation and receipt never disagree on
 * which store — a `/worktree`-suffixed workspace does not false-close.
 */
export function assertWorkspaceInitialized(workspace: string): CanonToolError | null {
  const root = normalizeWorkspaceRoot(workspace);
  let store: ReturnType<typeof getExecutionStore>;
  try {
    store = getExecutionStore(root);
  } catch (err) {
    return toolError(
      "WORKSPACE_NOT_FOUND",
      `Workspace not initialized (no execution store): ${root}`,
      false,
      { cause: String(err), workspace: root },
    );
  }
  if (store.getExecution() === null) {
    return toolError(
      "WORKSPACE_NOT_FOUND",
      `Workspace not initialized (no execution row): ${root}`,
      false,
      { workspace: root },
    );
  }
  return null;
}
