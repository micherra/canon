/** Write the selected node to .canon/dashboard-state.json for get_dashboard_selection to read. */

import { mkdir } from "fs/promises";
import { join, dirname, resolve, isAbsolute } from "path";
import { z } from "zod";
import { atomicWriteFile } from "../utils/atomic-write.js";
import { CANON_DIR } from "../constants.js";

export const SelectedNodeSchema = z.object({
  id: z.string().min(1).describe("Project-relative file path"),
  layer: z.string(),
  summary: z.string(),
  violation_count: z.number().int().min(0),
});

export const UpdateDashboardStateInputSchema = z.object({
  selectedNode: SelectedNodeSchema.nullable().optional(),
});

export type UpdateDashboardStateInput = z.infer<typeof UpdateDashboardStateInputSchema>;

export interface UpdateDashboardStateOutput {
  ok: boolean;
}

/**
 * Validates that a node id (used as a relative file path) does not escape
 * the project directory.  Rejects absolute paths and path traversal attempts.
 */
function safeResolveNodeId(projectDir: string, nodeId: string): string | null {
  if (isAbsolute(nodeId)) return null;
  if (nodeId.includes("..")) return null;
  const resolved = resolve(projectDir, nodeId);
  if (!resolved.startsWith(projectDir + "/") && resolved !== projectDir) return null;
  return resolved;
}

export async function updateDashboardState(
  input: UpdateDashboardStateInput,
  projectDir: string,
): Promise<UpdateDashboardStateOutput> {
  const parsed = UpdateDashboardStateInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false };

  const { selectedNode } = parsed.data;

  // Validate node id is a safe relative path if provided
  if (selectedNode?.id !== undefined) {
    const safe = safeResolveNodeId(projectDir, selectedNode.id);
    if (!safe) return { ok: false };
  }

  const statePath = join(projectDir, CANON_DIR, "dashboard-state.json");
  const payload = {
    selectedNode: selectedNode ?? null,
    timestamp: new Date().toISOString(),
  };

  try {
    await mkdir(dirname(statePath), { recursive: true });
    await atomicWriteFile(statePath, JSON.stringify(payload, null, 2));
    return { ok: true };
  } catch {
    return { ok: false };
  }
}
