/**
 * tail_messages — MCP tool to poll cross-session chatter on a build.
 *
 * Reuses the existing, already-tested `messages` DAO on the per-workspace
 * orchestration.db (`ExecutionStore.getMessagesSinceId`) — no schema/DAO
 * change there (Inc 0 constraint). The channel is the workspace path itself.
 *
 * Registry-gated (fail-closed) symmetrically with post_message: unknown or
 * `reaped` workspaces are rejected — a reaped workspace's orchestration.db is
 * gone anyway, so the gate returns a truthful "reaped" rejection rather than
 * an indistinguishable "never existed" (decision registry-store-location-02.md
 * decision 3).
 *
 * Also surfaces `peer_lock` — the current workspace-mutex holder, read via
 * `readLock` — as a liveness signal ("who else is on this build right now").
 *
 * Best-effort ordered poll — no delivery guarantee, no push/subscribe: SQLite
 * is a store, not a bus. See the tool description in register-messaging.ts.
 */

import { isAbsolute } from "node:path";
import { getExecutionStore } from "@domains/workspaces/execution-store-cache.ts";
import { getDriftDb } from "@platform/storage/drift/drift-db-cache.ts";
import type { ToolResult } from "@shared/lib/tool-result.ts";
import { toolError, toolOk } from "@shared/lib/tool-result.ts";
import { type LockRecord, readLock } from "../services/workspace-lock.ts";

type TailMessagesInput = {
  workspace: string;
  since_id?: number;
};

type MessageOutput = {
  id: number;
  channel: string;
  sender: string;
  content: string;
  timestamp: string;
};

type TailMessagesResult = {
  messages: MessageOutput[];
  last_id: number;
  peer_lock: LockRecord | null;
};

export async function tailMessages(
  input: TailMessagesInput,
  projectDir: string,
): Promise<ToolResult<TailMessagesResult>> {
  const { workspace } = input;
  const sinceId = input.since_id ?? 0;

  if (!isAbsolute(workspace)) {
    return toolError("INVALID_INPUT", `workspace must be an absolute path; got: "${workspace}"`);
  }
  if (!Number.isInteger(sinceId) || sinceId < 0) {
    return toolError(
      "INVALID_INPUT",
      `since_id must be a non-negative integer; got: ${input.since_id}`,
      false,
    );
  }

  // Registry gate (fail-closed): symmetric with post_message.
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

  const messages = store.getMessagesSinceId(workspace, sinceId);
  const lastId = messages.length > 0 ? messages[messages.length - 1].id : sinceId;
  const peerLock = readLock(workspace);

  return toolOk({ last_id: lastId, messages, peer_lock: peerLock });
}
