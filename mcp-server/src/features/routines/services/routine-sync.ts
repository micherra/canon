import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { atomicWriteFile } from "@shared/lib/atomic-write.ts";
import { rawUntrustedForStructuralUse } from "@shared/lib/overlay-untrusted-text.ts";
import type { ToolResult } from "@shared/lib/tool-result.ts";
import { toolError, toolOk } from "@shared/lib/tool-result.ts";
import type { Routine } from "@shared/routine.ts";
import { resolveRoutineBinding } from "./resolve-binding.ts";
import type { RoutineEnv } from "./routine-drift.ts";
import { generateRoutinesIndex } from "./routine-index.ts";

// ---------------------------------------------------------------------------
// emitCloudRecipe
// ---------------------------------------------------------------------------

/**
 * Emit a `/schedule` recipe string for a cloud-bound routine.
 *
 * CANNOT auto-create (cloud resources require user consent + account context).
 * Returns a text recipe the user can paste to register the routine.
 *
 * Invariant: the emitted recipe must NOT embed any `.canon/` path so that it
 * remains runnable on a fresh clone without Canon state (AC#10).
 *
 * Pure function — no I/O, no side effects (simplicity-first).
 */
export function emitCloudRecipe(routine: Routine): string {
  const reposSection = routine.repos.length > 0 ? routine.repos.join(", ") : "(all repos in scope)";

  const triggerLine =
    routine.trigger.kind === "schedule" && routine.trigger.cron
      ? `trigger: schedule (${routine.trigger.cron})`
      : routine.trigger.kind === "github-event" && routine.trigger.event
        ? `trigger: github-event (${routine.trigger.event})`
        : `trigger: ${routine.trigger.kind}`;

  // rawUntrustedForStructuralUse: emitCloudRecipe writes a disk artifact (non-model-facing).
  // The recipe is a user-paste document, not a tool output consumed by the model.
  const rawTitle = rawUntrustedForStructuralUse(routine.title);
  const rawBody = rawUntrustedForStructuralUse(routine.body);

  const lines = [
    `# Canon routine: ${routine.name}`,
    `# ${rawTitle}`,
    `#`,
    `# To register this routine in Claude.ai / Claude Scheduled Tasks,`,
    `# copy this recipe and follow the platform's /schedule setup steps.`,
    ``,
    `/schedule`,
    `name: ${routine.name}`,
    triggerLine,
    `repos: ${reposSection}`,
    ``,
    `## Task body`,
    ``,
    rawBody,
  ];

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// writeDesktopSkill
// ---------------------------------------------------------------------------

/**
 * Write/refresh a desktop scheduled-task SKILL.md for a routine.
 *
 * Writes to `${homeDir}/.claude/scheduled-tasks/<name>/SKILL.md` using an
 * atomic write. This is the ONLY path that writes scheduled-task SKILL.md
 * files — all desktop-task binding creation flows through here.
 *
 * Returns the written path on success; returns a ToolError on failure.
 * Never throws for expected error conditions (errors-are-values).
 */
export async function writeDesktopSkill(
  routine: Routine,
  homeDir: string,
): Promise<ToolResult<{ path: string }>> {
  const skillPath = join(homeDir, ".claude", "scheduled-tasks", routine.name, "SKILL.md");
  try {
    await mkdir(dirname(skillPath), { recursive: true });
    await atomicWriteFile(skillPath, buildSkillContent(routine));
    return toolOk({ path: skillPath });
  } catch (err) {
    return toolError(
      "UNEXPECTED",
      `Failed to write desktop SKILL.md for ${routine.name}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function buildSkillContent(routine: Routine): string {
  // rawUntrustedForStructuralUse: SKILL.md is a disk artifact (non-model-facing).
  return [
    `---`,
    `name: ${routine.name}`,
    `title: ${rawUntrustedForStructuralUse(routine.title)}`,
    `status: ${routine.status}`,
    `---`,
    ``,
    rawUntrustedForStructuralUse(routine.body),
    ``,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// syncRoutine
// ---------------------------------------------------------------------------

/**
 * Sync a single routine to its binding target and regenerate the managed index.
 *
 * Dispatch logic:
 *   - cloud-routine → `emitCloudRecipe` (returns recipe text, no write)
 *   - desktop-task  → `writeDesktopSkill` (writes SKILL.md via atomic write)
 *
 * Also regenerates the `routines/.claude/CLAUDE.md` index after a successful
 * sync. The index write path is injected so callers can provide the project
 * directory; when `indexPath` is provided, the index is written atomically.
 *
 * @param routine     The routine to sync
 * @param env         Binding drift env (homeDir + optional seams)
 * @param allRoutines All routines (for index regeneration)
 * @param indexPath   Optional path to write the generated index file
 */
export async function syncRoutine(
  routine: Routine,
  env: RoutineEnv,
  allRoutines: Routine[],
  indexPath?: string,
): Promise<ToolResult<{ kind: "recipe"; recipe: string } | { kind: "desktop"; path: string }>> {
  const { target } = resolveRoutineBinding(routine);

  let result: ToolResult<{ kind: "recipe"; recipe: string } | { kind: "desktop"; path: string }>;

  if (target === "cloud-routine") {
    const recipe = emitCloudRecipe(routine);
    result = toolOk({ kind: "recipe" as const, recipe });
  } else {
    const writeResult = await writeDesktopSkill(routine, env.homeDir);
    if (!writeResult.ok) {
      return writeResult;
    }
    result = toolOk({ kind: "desktop" as const, path: writeResult.path });
  }

  // Regenerate the managed index after a successful sync
  if (indexPath) {
    const indexContent = generateRoutinesIndex(allRoutines);
    try {
      await mkdir(dirname(indexPath), { recursive: true });
      await atomicWriteFile(indexPath, indexContent);
    } catch {
      // Index write failure is advisory — the sync itself succeeded
      console.warn("[canon] routine-sync: failed to regenerate index at", indexPath);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// syncAllRoutines
// ---------------------------------------------------------------------------

/**
 * Sync all provided routines in parallel (no for...of await).
 *
 * Returns an array of sync results in the same order as the input.
 * Individual failures are captured as ToolErrors and do not abort the batch.
 */
export async function syncAllRoutines(
  routines: Routine[],
  env: RoutineEnv,
  indexPath?: string,
): Promise<
  Array<ToolResult<{ kind: "recipe"; recipe: string } | { kind: "desktop"; path: string }>>
> {
  return Promise.all(routines.map((r) => syncRoutine(r, env, routines, indexPath)));
}
