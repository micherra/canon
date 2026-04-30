/**
 * dag-validator.ts — Pure validation utility for task-dag.yaml content.
 *
 * Validates a TaskDag structure and returns all errors found (not short-circuit).
 * Cycle detection uses Kahn's algorithm (topological sort via in-degree reduction).
 */

export type TaskNode = {
  task_id: string;
  depends_on: string[];
  parallel_safe: boolean;
  files: string[];
};

export type TaskDag = {
  tasks: TaskNode[];
};

export type DagValidationResult = {
  valid: boolean;
  errors: string[];
};

/** Check 2: Collect tasks with empty/whitespace-only task_id. */
function collectEmptyIdErrors(tasks: TaskNode[]): string[] {
  const errors: string[] = [];
  for (let i = 0; i < tasks.length; i++) {
    if (tasks[i].task_id.trim() === "") {
      errors.push(`Task at index ${i} has empty task_id`);
    }
  }
  return errors;
}

/** Check 3: Collect duplicate task_id errors (skips empty ids). */
function collectDuplicateIdErrors(tasks: TaskNode[]): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  const reported = new Set<string>();
  for (const task of tasks) {
    const id = task.task_id;
    if (id.trim() === "") continue;
    if (seen.has(id) && !reported.has(id)) {
      errors.push(`Duplicate task_id: ${id}`);
      reported.add(id);
    } else {
      seen.add(id);
    }
  }
  return errors;
}

/** Check 4: Collect self-reference errors (skips empty ids). */
function collectSelfReferenceErrors(tasks: TaskNode[]): string[] {
  const errors: string[] = [];
  for (const task of tasks) {
    if (task.task_id.trim() === "") continue;
    if (task.depends_on.includes(task.task_id)) {
      errors.push(`Task '${task.task_id}' depends on itself`);
    }
  }
  return errors;
}

/** Check 5: Collect unresolved dependency reference errors. Returns errors and whether any exist. */
function collectUnresolvedRefErrors(
  tasks: TaskNode[],
  allIds: Set<string>,
): { errors: string[]; hasUnresolved: boolean } {
  const errors: string[] = [];
  let hasUnresolved = false;
  for (const task of tasks) {
    if (task.task_id.trim() === "") continue;
    for (const dep of task.depends_on) {
      if (dep === task.task_id) continue; // Already caught as self-reference
      if (!allIds.has(dep)) {
        errors.push(`Task '${task.task_id}' depends on unknown task '${dep}'`);
        hasUnresolved = true;
      }
    }
  }
  return { errors, hasUnresolved };
}

/**
 * Validate a TaskDag structure.
 *
 * Checks (in order):
 * 1. Empty DAG — at least one task required
 * 2. Empty task_id — no task may have empty/whitespace-only task_id
 * 3. Duplicate task_ids — all task_id values must be unique
 * 4. Self-references — no task may depend on itself
 * 5. Unresolved references — every depends_on entry must match an existing task_id
 * 6. Cycle detection — runs only when references are valid (no unresolved refs)
 *
 * Returns all errors collected (does not short-circuit after first error),
 * except that cycle detection only runs when no unresolved reference errors exist.
 */
export function validateDag(dag: TaskDag): DagValidationResult {
  const errors: string[] = [];

  // Check 1: Empty DAG
  if (dag.tasks.length === 0) {
    return { errors: ["DAG must contain at least one task"], valid: false };
  }

  // Check 2: Empty task_id
  errors.push(...collectEmptyIdErrors(dag.tasks));

  // Check 3: Duplicate task_ids
  errors.push(...collectDuplicateIdErrors(dag.tasks));

  // Build set of all known (non-empty) ids for reference checks
  const allIds = new Set<string>(dag.tasks.map((t) => t.task_id).filter((id) => id.trim() !== ""));

  // Check 4: Self-references
  errors.push(...collectSelfReferenceErrors(dag.tasks));

  // Check 5: Unresolved references
  const { errors: refErrors, hasUnresolved } = collectUnresolvedRefErrors(dag.tasks, allIds);
  errors.push(...refErrors);

  // Check 6: Cycle detection (only when no unresolved references)
  if (!hasUnresolved) {
    const cycleError = detectCycle(dag);
    if (cycleError !== null) {
      errors.push(cycleError);
    }
  }

  return { errors, valid: errors.length === 0 };
}

/** Initialize graph node entries for each task. */
function initGraphNodes(
  tasks: TaskNode[],
  inDegree: Map<string, number>,
  dependents: Map<string, string[]>,
): void {
  for (const task of tasks) {
    if (!inDegree.has(task.task_id)) inDegree.set(task.task_id, 0);
    if (!dependents.has(task.task_id)) dependents.set(task.task_id, []);
  }
}

/** Add edges for a single task's dependencies. */
function addTaskEdges(
  task: TaskNode,
  inDegree: Map<string, number>,
  dependents: Map<string, string[]>,
): void {
  for (const dep of task.depends_on) {
    if (dep === task.task_id) continue; // Self-references already reported
    inDegree.set(task.task_id, (inDegree.get(task.task_id) ?? 0) + 1);
    const depDependents = dependents.get(dep) ?? [];
    depDependents.push(task.task_id);
    dependents.set(dep, depDependents);
  }
}

/** Build in-degree map and dependents adjacency list for non-empty tasks. */
function buildGraph(tasks: TaskNode[]): {
  dependents: Map<string, string[]>;
  inDegree: Map<string, number>;
} {
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  initGraphNodes(tasks, inDegree, dependents);
  for (const task of tasks) {
    addTaskEdges(task, inDegree, dependents);
  }

  return { dependents, inDegree };
}

/** Run Kahn's algorithm; return count of processed nodes. */
function kahnProcess(inDegree: Map<string, number>, dependents: Map<string, string[]>): number {
  const queue: string[] = [];
  for (const [id, degree] of inDegree) {
    if (degree === 0) queue.push(id);
  }

  let processedCount = 0;
  while (queue.length > 0) {
    const current = queue.shift()!;
    processedCount++;
    for (const dependent of dependents.get(current) ?? []) {
      const newDegree = (inDegree.get(dependent) ?? 0) - 1;
      inDegree.set(dependent, newDegree);
      if (newDegree === 0) queue.push(dependent);
    }
  }

  return processedCount;
}

/**
 * Detect cycles using Kahn's algorithm (topological sort via in-degree reduction).
 *
 * Returns a single error string listing the cycle participants (sorted alphabetically),
 * or null when no cycle is found.
 *
 * Precondition: all task_ids are non-empty and all depends_on entries resolve to
 * known task_ids (unresolved refs check has passed).
 */
function detectCycle(dag: TaskDag): string | null {
  // Skip tasks with empty task_ids (already caught above)
  const tasks = dag.tasks.filter((t) => t.task_id.trim() !== "");

  const { inDegree, dependents } = buildGraph(tasks);
  const processedCount = kahnProcess(inDegree, dependents);

  // If not all nodes were processed, remaining nodes are in a cycle
  if (processedCount < tasks.length) {
    const cycleNodes: string[] = [];
    for (const [id, degree] of inDegree) {
      if (degree > 0) cycleNodes.push(id);
    }
    cycleNodes.sort();
    return `Cycle detected involving tasks: ${cycleNodes.join(", ")}`;
  }

  return null;
}
