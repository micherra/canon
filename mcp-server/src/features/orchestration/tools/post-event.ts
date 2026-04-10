/**
 * post_event — MCP tool for agents to log structured activity events.
 *
 * Agents call this at the start and completion of significant work units.
 * Events are written to the SQLite execution store's event log for
 * cross-build analysis and pattern mining.
 */

import type { WorkspacePath } from "@domains/flows/board-state-schemas.ts";
import { getExecutionStore } from "@domains/workspaces/execution-store.ts";
import type { ToolResult } from "@shared/lib/tool-result.ts";
import { toolError, toolOk } from "@shared/lib/tool-result.ts";

type PostEventInput = {
  workspace: WorkspacePath;
  agent: string;
  action: "start" | "complete";
  detail: string;
  artifacts?: string[];
};

type PostEventResult = {
  logged: true;
  event_type: "agent_activity";
};

export async function postEvent(input: PostEventInput): Promise<ToolResult<PostEventResult>> {
  const { workspace, agent, action, detail, artifacts } = input;

  // Validate required fields
  if (!agent?.trim()) {
    return toolError("INVALID_INPUT", "agent must be a non-empty string", false);
  }
  if (!detail?.trim()) {
    return toolError("INVALID_INPUT", "detail must be a non-empty string", false);
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

  const payload: Record<string, unknown> = {
    action,
    agent,
    detail,
    timestamp: new Date().toISOString(),
  };
  if (artifacts && artifacts.length > 0) {
    payload.artifacts = artifacts;
  }

  store.appendEvent("agent_activity", payload);

  return toolOk({ event_type: "agent_activity" as const, logged: true as const });
}
