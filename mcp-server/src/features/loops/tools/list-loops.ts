/**
 * list_loops MCP tool handler.
 *
 * Pure query (command-query-separation) — no side effects.
 * Returns all active loop definitions from the loops/ directory,
 * with optional lifecycle_hook + tier filtering.
 *
 * The invalid[] channel is ALWAYS returned so the orchestrator can surface
 * malformed definitions (observable-best-effort principle).
 */

import type { ToolResult } from "@shared/lib/tool-result.ts";
import { toolOk } from "@shared/lib/tool-result.ts";
import { loadLoopsFromDir } from "../load-loops.ts";

export type ListLoopsInput = {
  /** When provided, only return loops with this lifecycle_hook. */
  lifecycle_hook?: string;
  /** When provided, annotate each loop's firing_posture for this tier. */
  tier?: string;
};

export type LoopSummary = {
  id: string;
  title: string;
  status: string;
  mode: string;
  lifecycle_hook: string | undefined;
  /** Firing posture value for the requested tier, when tier was provided. */
  firing_posture_for_tier?: string;
};

export type ListLoopsOutput = {
  loops: LoopSummary[];
  invalid: { file: string; error: string }[];
  total: number;
};

/**
 * Core handler — accepts the loopsDir directly (the loops/ registry directory).
 * Separated from MCP registration so it's directly testable without MCP infra.
 * In MCP registration, pass join(pluginDir, "loops") as the first argument.
 */
export async function listLoopsHandler(
  loopsDir: string,
  input: ListLoopsInput,
): Promise<ToolResult<ListLoopsOutput>> {
  // loadLoopsFromDir itself is fail-open and never throws for expected conditions.
  // Wrap in try/catch as an extra belt-and-suspenders for unexpected errors.
  let loaded: Awaited<ReturnType<typeof loadLoopsFromDir>>;
  try {
    loaded = await loadLoopsFromDir(loopsDir);
  } catch (err) {
    // Fail-open: surface error but return empty result (not a throw)
    return toolOk({
      invalid: [
        {
          error: `loader error: ${err instanceof Error ? err.message : String(err)}`,
          file: loopsDir,
        },
      ],
      loops: [],
      total: 0,
    });
  }

  // Filter to status:active only
  let active = loaded.valid.filter((def) => def.status === "active");

  // Filter by lifecycle_hook when provided
  if (input.lifecycle_hook) {
    active = active.filter((def) => def.trigger?.lifecycle_hook === input.lifecycle_hook);
  }

  const loops: LoopSummary[] = active.map((def) => {
    const summary: LoopSummary = {
      id: def.id,
      lifecycle_hook: def.trigger?.lifecycle_hook,
      mode: def.mode,
      status: def.status,
      title: def.title,
    };

    // Annotate firing_posture for the requested tier
    if (input.tier && def.trigger?.firing_posture) {
      const posture = def.trigger.firing_posture as Record<string, string>;
      summary.firing_posture_for_tier = posture[input.tier];
    }

    return summary;
  });

  return toolOk({
    invalid: loaded.invalid,
    loops,
    total: loops.length,
  });
}
