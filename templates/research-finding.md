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

### Existing Code Documentation
<!-- Relevant files, key exports, and how they work. Include file paths. -->
- `path/to/file.ts` — {what this file does, key exports, and why it matters}

### Relevant Patterns in Codebase
<!-- What already exists in the codebase that the architect/implementor should know about. Include file paths. -->
- [Pattern name] — used in `path/to/file.ts`: {description of pattern}

### Dependency Map
<!-- Imports, call sites, or integration points that matter for this research dimension. -->
- `path/to/file.ts` → imports from / used by {list}

### Files in Task Area
<!-- Files, modules, or interfaces related to the task area. -->
- `path/to/file.ts` — {what it does and why it's relevant}

### External Research
<!-- Relevant docs, API references, changelogs, issues, or community discussions. -->
- {source title or topic} — {why it matters}

### External Evidence
<!-- Required when material external claims appear in the findings. -->
- **URLs**: {list the source URLs used for material external claims}
- **Facts**: {externally supported facts only}
- **Assumptions**: {inferences or points that still need verification}
- **Open Questions**: {unknowns the architect should resolve}

### Applicable Canon Principles
<!-- Which principles are most relevant to this task dimension. -->
- **{principle-id}** — relevant because {reason}

### Ambiguities and Risks
<!-- Anything the architect should factor into the design. -->
- {constraint, ambiguity, or risk}
```

## Rules

- Lead with the most important finding
- Include file paths for every reference to existing code
- Do not duplicate findings across dimensions — stay in your lane
- Do not recommend an approach or prescribe a solution
- Include source URLs for every material external claim
