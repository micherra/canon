import type { Routine } from "@shared/routine.ts";

/**
 * Resolve the canonical binding target for a set of needs.
 *
 * Rule: git-native AND NOT daemon → "cloud-routine"; else → "desktop-task".
 *
 * Pure function — no I/O, no side effects (simplicity-first).
 */
export function resolveBinding(needs: Routine["needs"]): "cloud-routine" | "desktop-task" {
  if (needs.state === "git-native" && !needs.daemon) {
    return "cloud-routine";
  }
  return "desktop-task";
}

/**
 * Resolve the binding for a full Routine, surfacing whether an explicit
 * `binding_target` override is present.
 *
 * - `target`: the canonical value from `resolveBinding(routine.needs)`
 * - `overridden`: true when `routine.binding_target` is explicitly set
 *   (regardless of whether it agrees — contradiction detection is the
 *   responsibility of `lintRoutines`, not this resolver).
 *
 * Pure function — no I/O, no side effects (simplicity-first).
 */
export function resolveRoutineBinding(routine: Routine): {
  target: "cloud-routine" | "desktop-task";
  overridden: boolean;
} {
  const target = resolveBinding(routine.needs);
  const overridden = routine.binding_target !== undefined;
  return { overridden, target };
}
