---
template: design-decision
description: Structured format for recording architectural and design decisions
used-by: [canon-architect]
---

# Template: Design Decision

Use this template when the architect makes a non-obvious decision that downstream agents or future sessions should understand.

```markdown
---
decision-id: "{slug}-{NN}"
title: "{brief title}"
status: "accepted"
agent: canon-architect
timestamp: "{ISO-8601}"
---

## Decision: {title}

### Context
<!-- What prompted this decision? What problem are we solving? -->
{context}

### Options Considered

#### Option A: {name}
- **Pros**: {advantages}
- **Cons**: {disadvantages}
- **Canon alignment**: {which principles it honors/tensions}

#### Option B: {name}
- **Pros**: {advantages}
- **Cons**: {disadvantages}
- **Canon alignment**: {which principles it honors/tensions}

### Chosen: Option {X}

### Rationale
<!-- Why this option? Tie to Canon principles where possible. -->
{rationale}

### Consequences
<!-- What does this decision mean for implementation? -->
- {consequence}

### Revisit If
<!-- Under what conditions should this decision be reconsidered? -->
- {trigger}
```

## Rules

- One decision per file — keep them atomic
- File naming: `{decision-id}.md` (e.g., `auth-01.md`)
- Always include at least 2 options — if the choice was obvious, you don't need a decision doc
- Tie rationale to Canon principles whenever possible
- Keep under 400 tokens — decisions should be concise
