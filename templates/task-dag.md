---
template: task-dag
description: DAG schema for parallel task execution in multi-task builds
used-by: [architect]
read-by: [orchestrator]
output-path: ${WORKSPACE}/plans/${slug}/task-dag.yaml
---

# Template: Task DAG

```yaml
# task-dag.yaml — produced by the architect for multi-task builds
# The orchestrator reads this to resolve task readiness and dispatch parallel batches.

tasks:
  - task_id: "{task-id}"           # Must match a task plan's task_id
    depends_on: []                  # List of task_ids that must complete before this task
    parallel_safe: true             # false = must execute alone, never batched
    files:                          # Files this task touches (for claim registration)
      - "path/to/file.ts"
```

## Rules

- Every `task_id` must have a corresponding `{task_id}-PLAN.md` in the same directory
- `depends_on` entries must reference existing `task_id` values in the same DAG
- No cycles — the dependency graph must be a DAG (directed acyclic graph)
- No self-references in `depends_on`
- `parallel_safe: false` tasks execute sequentially regardless of dependency readiness
- Tasks with no `depends_on` (root nodes) are immediately ready to execute
- The orchestrator processes the DAG after all task plans are written — the DAG is the last architect artifact
- Review, context-sync, and learn steps are NOT in the DAG — they run as a fixed sequential tail

## Example

```yaml
tasks:
  - task_id: "dag-based-parallel-01"
    depends_on: []
    parallel_safe: true
    files:
      - "src/features/orchestration/dag-resolver.ts"
      - "src/features/orchestration/dag-resolver.test.ts"

  - task_id: "dag-based-parallel-02"
    depends_on: []
    parallel_safe: true
    files:
      - "src/domains/dag.ts"

  - task_id: "dag-based-parallel-03"
    depends_on:
      - "dag-based-parallel-01"
      - "dag-based-parallel-02"
    parallel_safe: true
    files:
      - "src/features/orchestration/dispatch.ts"

  - task_id: "dag-based-parallel-04"
    depends_on:
      - "dag-based-parallel-03"
    parallel_safe: false
    files:
      - "src/app/index.ts"
      - "CLAUDE.md"
```
