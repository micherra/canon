---
template: plan-index
description: Index of all task plans for a build
used-by: [architect]
read-by: [canon-orchestrator, implementor]
output-path: ${WORKSPACE}/plans/${slug}/INDEX.md
---

# Template: Plan Index

```markdown
## Plan Index: {task description}

| Task | Wave | Depends on | Files | Principles |
|------|------|------------|-------|------------|
| {slug}-01 | 1 | — | path/to/file.ts | principle-id |
```
