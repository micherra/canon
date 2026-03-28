---
template: design-document
description: Structured format for design documents with North Star section
used-by: [canon-architect]
read-by: [canon-implementor, canon-reviewer]
output-path: ${WORKSPACE}/plans/${slug}/DESIGN.md
---

# Template: Design Document

Use this template when the architect produces a design for a task.

```markdown
---
done_criteria:
  - id: "dc-01"
    description: "{criterion description}"
    testable: "{how to verify — command, file check, or manual inspection}"
  - id: "dc-02"
    description: "{criterion description}"
    testable: "{how to verify}"
---

## Design: {task description}

### North Star

**Vision**: {One sentence — what does success look like when this is fully done?}

**Done criteria**: See frontmatter above. These are the machine-readable exit conditions for the epic. When all are met, the flow transitions to ship via `epic_complete`.

**Constraints**: {Non-negotiable boundaries — performance budgets, backward compatibility requirements, security invariants}

### Approach
{Description of the chosen approach}

### Canon alignment
- {principle-id} — how it is honored
- {principle-id} — tension noted and justified

### File structure
- path/to/file.ts — purpose

### Decisions made
- {decision and rationale, tied to principle}

### Open questions for user
- {questions that need human input}
```

## Rules

- The North Star section comes first — it anchors the entire epic
- Done criteria MUST be in frontmatter as a YAML array for machine parsing
- Each done criterion needs an `id`, `description`, and `testable` field
- The `testable` field should be specific enough that an agent can evaluate it
- Everything below North Star can evolve between waves via architect replan
- Keep done criteria to 3-7 items — more than that signals the epic should be split
