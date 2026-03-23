---
template: session-context
description: Living shared context document for the workspace
used-by: [canon-architect]
read-by: [canon-implementor]
output-path: ${WORKSPACE}/context.md
---

# Template: Session Context

The `context.md` file in each workspace is a living document that the architect initializes and updates. Other agents read it for shared context. Only the architect writes to it.

```markdown
## Workspace Context: {task description}

### Goal
<!-- One-sentence summary of what this branch is trying to accomplish. -->
{goal}

### Architecture Summary
<!-- Key architectural decisions for this task. Updated as decisions are made. -->
- {decision}

### Key Patterns
<!-- Patterns agents should follow in this workspace. -->
- {pattern}

### Known Issues
<!-- Problems discovered during the session that haven't been resolved yet. -->
- {issue}

### Agent Notes
<!-- Important observations from agents, added by the architect when surfaced. -->
- [{agent}] {observation}
```

## Rules

- Initialized by the architect after producing the design
- Updated by the architect when new information surfaces (from implementor concerns, tester findings, etc.)
- Other agents read but do not write — the architect is the single owner
- Delete resolved issues and outdated notes to keep it current
