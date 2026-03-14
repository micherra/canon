---
id: agent-falsifiable-constraints
title: Principles Must Be Falsifiable
severity: rule
scope:
  layers: []
  file_patterns:
    - ".canon/principles/**"
tags:
  - agent-behavior
  - principle-writer
---

Every Canon principle must be stated as a falsifiable constraint. A reader (human or AI) should be able to look at code and say "this violates principle X" or "this does not." Principles that cannot be violated cannot be enforced.

## Rationale

Vague principles ("write clean code," "follow best practices," "keep things simple") are worse than no principles because they give the illusion of guidance while being impossible to evaluate against. The principle writer agent must produce constraints that the reviewer agent can actually check. If a principle can't be expressed with a good and bad code example, it's not concrete enough.

## Examples

**Bad — unfalsifiable principle:**

```markdown
---
id: clean-code
title: Write Clean Code
severity: strong-opinion
---

Code should be clean, readable, and maintainable. Follow best practices
for the language and framework you're using.
```

(How would a reviewer check this? What counts as "clean"?)

**Good — falsifiable constraint:**

```markdown
---
id: thin-handlers
title: Handlers Are Thin Orchestrators
severity: strong-opinion
---

HTTP handlers should do three things: validate input, call a service, and
return a response. Business logic does not belong in the handler.
```

(A reviewer can look at any handler and say: "this contains business logic" or "this only validates, delegates, and returns.")

## Exceptions

Philosophical principles that set overall direction (like simplicity-first) are acceptable if they include concrete examples that make violation recognizable. The test: can you write a bad example? If yes, the principle is falsifiable enough.
