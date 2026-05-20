---
template: task-plan
description: Atomic task plan for implementor agents
used-by: [architect]
read-by: [implementor]
output-path: ${WORKSPACE}/plans/${slug}/${task-id}-PLAN.md
---

# Template: Task Plan

```markdown
---
task_id: "{slug}-{NN}"
wave: N
depends_on: []
decisions:
  - "{decision-id}"
files:
  - path/to/file.ts
principles:
  - principle-id-1
domains:
  - frontend
---

## Task: {brief description}

### Action
[Specific instructions: exact function signatures, patterns to follow, imports needed]

### Canon principles to apply
- **{principle-id}**: How to apply it specifically to this task

### Risk mitigations
<!-- Extracted from risk research. Each item becomes a required test or acceptance criterion. -->
<!-- Omit this section only if no risk findings apply to this task's files. -->
- {risk finding}: {how to mitigate — specific test to write or guard to implement}

### Tests to write
- {test file path}: {what to test}
- {test file path}: {risk mitigation test — from risk research}

### Verify
1. All new tests pass: `{test command}`
2. Existing tests still pass: `{project test command}`
3. All risk mitigations verified: {specific checks}

### Done when
[Clear, testable completion criteria — must include "all tests pass" and "all risk mitigations addressed"]
- [ ] All tests pass and all risk mitigations addressed
<!-- If this task introduces a new gate or rule, add the following items: -->
- [ ] Negative scope stated: what intents or contexts this gate does NOT apply to (required for any new gate or rule)
- [ ] Taxonomy registration: rule file is listed in `rules/.claude/CLAUDE.md` under the appropriate behavioral category (required for any new rule file)

### Brief Coverage
<!-- Map every requirement from the approved runbook to a task element or explicitly mark it out-of-scope. -->
<!-- The orchestrator checks this section — missing rows or unjustified gaps block progression. -->
| # | Runbook requirement | Disposition | Task element or rationale |
|---|---------------------|-------------|--------------------------|
| 1 | {requirement from runbook} | {covered &#124; descoped &#124; partial} | {which task element addresses it, or why it's out of scope} |
```

## Rules

- Before adding nesting (loops, switches, conditionals) to an existing function, check its current cognitive complexity. If the function already has a switch or nested loop, extract a helper first to stay under the Biome complexity threshold.
- Each task should complete in ~50% of a fresh context window
- Touch a small, well-defined set of files
- Include tests the implementor writes alongside the code
- Have concrete verification steps
- Be independently committable
- **Integration task required for user-observable ACs**: When ACs include user-observable outcomes (HTTP endpoint, browser response, CLI output), the DAG MUST include an integration task that wires components together. It `depends_on` all component tasks and its ACs verify the observable behavior directly.
- **Hotspot extraction planning**: When a task modifies a file with `is_hotspot: true` (from `get_file_context`), the `files:` frontmatter must list expected extraction targets (new files created by decomposition) OR include a comment `# no extraction needed — {rationale}`. Silence on extraction for hotspot files is an incomplete plan.
