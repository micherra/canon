---
template: research-finding
description: Structured format for researcher agent output
used-by: [canon-researcher]
read-by: [canon-architect]
output-path: orchestrator-provided
---

# Template: Research Finding

Use this template when producing research findings for the workspace.

```markdown
---
dimension: "{codebase|architecture|domain|risk}"
task: "{task description}"
agent: canon-researcher
timestamp: "{ISO-8601}"
---

## {Dimension} Research: {task description}

### Key Findings
<!-- Most important discoveries first. Max 5 bullets. Each finding should be actionable. -->
- {finding}

### Relevant Existing Patterns
<!-- What already exists in the codebase that the architect/implementor should know about. Include file paths. -->
- `path/to/file.ts` — {description of pattern}

### Files Likely Affected
<!-- Files that will need to change, with reason. -->
- `path/to/file.ts` — {reason}

### Applicable Canon Principles
<!-- Which principles are most relevant to this task dimension. -->
- **{principle-id}** — relevant because {reason}

### Constraints and Risks
<!-- Anything the architect should factor into the design. -->
- {constraint or risk}

### Recommendation
<!-- One-paragraph recommendation based on findings. -->
{recommendation}
```

## Rules

- Lead with the most important finding
- Include file paths for every reference to existing code
- Do not duplicate findings across dimensions — stay in your lane
