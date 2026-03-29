---
template: chat-brief
description: Structured brief from chat discussion for build handoff
used-by: [canon-chat]
read-by: [canon-orchestrator, canon-researcher, canon-architect]
output-path: .canon/briefs/${topic-slug}.md
---

# Template: Chat Brief

```markdown
---
topic: "{concise topic description}"
created: "{ISO-8601}"
status: ready
participants: [user, canon-chat]
---

## Context
{What prompted this discussion — the problem or opportunity}

## Key Decisions
- {Decision 1}: {chosen approach} — because {rationale}
- {Decision 2}: {chosen approach} — because {rationale}

## Constraints
- {Constraint the build must respect}

## Approach
{The agreed-upon approach in enough detail for an architect to skip discovery}

## Open Questions
- {Anything unresolved that research/design should address}

## Relevant Code
- `path/to/file.ts` — {why it's relevant}
```
