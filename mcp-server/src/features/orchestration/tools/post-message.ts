/**
 * post_message — MCP tool for cross-session chatter on a build.
 *
 * Reuses the existing, already-tested `messages` DAO on the per-workspace
 * orchestration.db (`ExecutionStore.appendMessage`) — no schema/DAO change
 * there (Inc 0 constraint). The channel is the workspace path itself: one
 * implicit channel per workspace, no channel abstraction at v0.
 *
 * Registry-gated (fail-closed, per fail-closed-by-default): a workspace must
 * be present in the project-level active_workspaces registry (drift.db) with
 * status `live` or `finalized_on_disk` to accept a post. Unknown or `reaped`
 * workspaces are rejected — the registry only *resolves/validates which
 * workspace*, it is not the message store (Probe A/B; see
 * decision registry-store-location-02.md).
 *
 * Best-effort ordered poll — no delivery guarantee, no push/subscribe. See
 * the tool description in register-messaging.ts for the consumer-facing bound.
 */

import { isAbsolute } from "node:path";
import { getExecutionStore } from "@domains/workspaces/execution-store-cache.ts";
import { getDriftDb } from "@platform/storage/drift/drift-db-cache.ts";
import type { ToolResult } from "@shared/lib/tool-result.ts";
import { toolError, toolOk } from "@shared/lib/tool-result.ts";

type PostMessageInput = {
  workspace: string;
  sender: string;
  content: string;
};

type PostMessageResult = {
  logged: true;
  id: number;
  timestamp: string;
};

export async function postMessage(
  input: PostMessageInput,
  projectDir: string,
): Promise<ToolResult<PostMessageResult>> {
  const { workspace, sender, content } = input;

  if (!isAbsolute(workspace)) {
    return toolError("INVALID_INPUT", `workspace must be an absolute path; got: "${workspace}"`);
  }
  if (!sender?.trim()) {
    return toolError("INVALID_INPUT", "sender must be a non-empty string", false);
  }
  if (!content?.trim()) {
    return toolError("INVALID_INPUT", "content must be a non-empty string", false);
  }

  // Registry gate (fail-closed): unknown or reaped workspaces are rejected.
  const registryRow = getDriftDb(projectDir).getActiveWorkspaces().getByPath(workspace);
  if (registryRow === null) {
    return toolError(
      "WORKSPACE_NOT_FOUND",
      `Workspace not in active registry: ${workspace}`,
      false,
      { workspace },
    );
  }
  if (registryRow.status === "reaped") {
    return toolError(
      "WORKSPACE_NOT_FOUND",
      `Workspace has been reaped; chatter unavailable: ${workspace}`,
      false,
      { workspace },
    );
  }

  let store: ReturnType<typeof getExecutionStore>;
  try {
    store = getExecutionStore(workspace);
  } catch (err) {
    return toolError("WORKSPACE_NOT_FOUND", `Workspace not found or invalid: ${workspace}`, false, {
      cause: String(err),
      workspace,
    });
  }

  // Channel = the workspace path string (single implicit channel per workspace).
  const message = store.appendMessage(workspace, sender, content);

  return toolOk({ id: message.id, logged: true as const, timestamp: message.timestamp });
}
