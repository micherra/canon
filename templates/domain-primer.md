# Domain Primer Template

## Purpose

Domain primers provide cognitive context that helps agents reason well in a specific domain. They sit between principles (which prescribe code properties) and agent rules (which govern agent behavior) — primers teach agents **how to think about the territory** so they apply principles and rules with good judgment.

## The Filter

Before adding anything to a primer, ask: **does an existing principle already say this?** If yes, don't repeat it. Primers provide domain reasoning that principles can't — the mental models, trade-off navigation, domain-specific failure physics, and overcorrection signals that are too contextual for universal principles.

## Structure

```markdown
# {Domain Name} Domain

## Mental Models

2-4 key thinking frameworks for this domain. Not rules — lenses that change what
the agent notices. Each should be a concept that no existing principle captures
but that makes multiple principles feel intuitive rather than arbitrary.

Format: **Name** — 2-4 sentences explaining the concept and why it matters in
this domain. Focus on insight, not instruction.

## Decision Frameworks

The judgment calls that principles can't prescribe. When the agent faces a fork
in this domain, how should it choose? Each framework should address a specific
recurring decision with clear heuristics.

Format: **Decision name** — describe the trade-off, the options, and when to
pick each one. Be opinionated about defaults.

## Failure Modes

Domain-specific mistakes agents make without knowing they're making them. Not
"don't do X" (that's a principle) but "here's a pattern that looks correct but
isn't, and why." Each should name a recognizable anti-pattern with enough
explanation that the agent can self-diagnose.

## Guardrails

How to know you've overcorrected. Each guardrail follows the pattern: "You
understood the principle correctly but applied it too aggressively. Here's the
signal you've gone too far." These prevent the shadow side of good practices.

Format: **Signal name** — "You should [correct thing]. If you're [overcorrection],
you've gone too far. [Why and what to do instead]."
```

## Guidelines

- **Length**: 40-80 lines. Long enough to shift cognition, short enough to fit in a spawn prompt alongside principles and rules.
- **No code examples**: The codebase and principles handle that. Primers are pure reasoning.
- **No process steps**: Agent rules handle behavioral sequences. Primers shape thinking, not workflow.
- **No "you should" that a principle already says**: If `validate-at-trust-boundaries` exists, the primer doesn't say "validate at the boundary." It might explain *what the boundaries are* in this domain if that's non-obvious.
- **Be opinionated about defaults**: "Default to cursor-based pagination unless..." is better than "consider your pagination options."
- **Name the anti-pattern**: "Testing the mock instead of the contract" is actionable. "Be careful with mocks" is not.
