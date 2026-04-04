---
id: agent-conflict-detection
title: Detect Principle Conflicts Before Saving
severity: rule
scope:
  layers: []
tags:
  - agent-behavior
  - writer
---

Before saving a new or modified principle, the writer agent must check the existing principle set for conflicts, overlaps, and contradictions. If a conflict is found, it must be surfaced to the user with both principles cited. The writer must never silently save a principle that contradicts an existing one.

## Rationale

Contradictory principles create impossible compliance targets. When principle A says "always validate at the boundary" and principle B says "trust internal callers," every reviewer and implementor must guess which one wins. The conflict is invisible until it causes a review disagreement or a build that loops between contradictory fix demands.

Catching conflicts at authoring time is cheap. Catching them at review time — when two agents disagree about what the code should do — is expensive and confusing.

## Examples

**Bad — writer saves without checking:**

```
User: "Create a principle: never throw exceptions, always return result types"
Writer: Saved `errors-are-values` to principles/strong-opinions/
```

(But `fail-closed-by-default` already says "throw on unrecoverable errors" — now they contradict.)

**Good — writer detects overlap and surfaces it:**

```
User: "Create a principle: never throw exceptions, always return result types"
Writer: Found potential conflict with `fail-closed-by-default` (rule severity):
  - Existing: "Unrecoverable errors must throw to prevent silent continuation"
  - Proposed: "Never throw exceptions"
  These overlap on error handling strategy. Options:
  1. Scope the new principle to recoverable errors only
  2. Add an exception clause referencing fail-closed
  3. Revise fail-closed to use result types instead
  Which approach do you prefer?
```

## Exceptions

None. Conflict detection is always required, even for convention-severity principles.
