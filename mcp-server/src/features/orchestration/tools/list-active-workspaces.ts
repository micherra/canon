/**
 * list_active_workspaces — MCP discovery tool over the project-level
 * active-workspaces registry (drift.db `active_workspaces`, v12).
 *
 * Lets a session discover another session's build without a pasted path —
 * the point of the registry-now decision (see decision registry-store-location-02.md).
 * Read-only; never throws (errors-are-values).
 */

import type {
  ActiveWorkspaceRow,
  ActiveWorkspaceStatus,
} from "@platform/storage/drift/active-workspaces-dao.ts";
import { getDriftDb } from "@platform/storage/drift/drift-db-cache.ts";
import type { ToolResult } from "@shared/lib/tool-result.ts";
import { toolError, toolOk } from "@shared/lib/tool-result.ts";

const VALID_STATUS_FILTERS: readonly ActiveWorkspaceStatus[] = [
  "live",
  "finalized_on_disk",
  "reaped",
];

type ListActiveWorkspacesInput = {
  status_filter?: string;
};

type ListActiveWorkspacesResult = {
  workspaces: ActiveWorkspaceRow[];
};

function isValidStatusFilter(value: string): value is ActiveWorkspaceStatus {
  return (VALID_STATUS_FILTERS as readonly string[]).includes(value);
}

export async function listActiveWorkspaces(
  input: ListActiveWorkspacesInput,
  projectDir: string,
): Promise<ToolResult<ListActiveWorkspacesResult>> {
  const { status_filter } = input;

  if (status_filter !== undefined && !isValidStatusFilter(status_filter)) {
    return toolError(
      "INVALID_INPUT",
      `status_filter must be one of ${VALID_STATUS_FILTERS.join(", ")}; got: "${status_filter}"`,
      false,
    );
  }

  const rows = getDriftDb(projectDir).getActiveWorkspaces().list(status_filter);
  return toolOk({ workspaces: rows });
}
