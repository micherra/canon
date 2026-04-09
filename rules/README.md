# Canon Rules

This directory contains agent-behavior rules — imperative constraints that govern how Canon's specialist agents operate during a build. Rules are distinct from principles: principles describe properties that good code should have; rules tell agents exactly what to do or not do while executing their work.

## Rules vs. Principles

It helps to think of these as two separate vocabularies:

**Principles** (in `principles/`) describe code quality invariants — things like "errors are values" or "validate at trust boundaries". They constrain what the code looks like.

**Rules** (here) constrain agent execution behavior — things like "always read the template before producing output" or "do not retry blindly when a test fails". They constrain how agents work, not what they produce.

A principle violation means the code is wrong. A rule violation means the agent is working incorrectly, which can produce a correct artifact through an unsafe or unreliable process.

## Behavioral Categories

Rules cluster into seven behavioral areas:

**Artifact rules** ensure agents produce the right outputs in the right format. The key ones govern template usage (agents must use the provided template, not invent their own structure) and artifact completeness (summaries and reports must include required sections).

**Research rules** govern how agents investigate before acting. They prevent agents from researching too broadly, making claims without evidence, or hiding assumptions that should be surfaced to the architect.

**Implementation rules** govern how agents write code. They enforce test-driven development, minimal changes (don't fix more than the task requires), and structured triage when something goes wrong (diagnose before retrying).

**Design rules** govern pre-code planning. Agents must design before coding and treat task plans as their authoritative instructions, not as suggestions to improvise around.

**Testing rules** ensure test quality beyond coverage numbers. Agents must test failure paths and test actual contracts, not implementation details.

**Coordination rules** manage how parallel agents stay coherent. Fresh-context isolation, workspace scoping, and conflict detection prevent agents working in parallel from trampling each other's work.

**Review rules** maintain review integrity. Reviewers must approach code cold (without pre-formed opinions from the implementor's summary) and treat all inputs as potentially hostile.

## File Format

Each rule is a concise markdown file named with the `agent-` prefix:

```markdown
---
id: agent-{behavior-name}
title: {Short Imperative Title}
severity: rule
tags: [agent-behavior, ...]
---

{One-paragraph statement of the constraint and why it exists.}

## Rule

{Numbered list of specific imperatives.}

## Why

{Rationale — what failure mode does this prevent?}
```

Rules are loaded verbatim into agent context at spawn time. Keep them concise and direct — agents have limited context budgets, and a rule that requires interpretation is a rule that will be misapplied.

## How Rules Are Assigned

The orchestrator and flow definitions determine which rules each agent receives. Not every agent gets every rule — a researcher gets the research rules and fresh-context rules; an implementor gets the implementation and testing rules. This scoping keeps each agent's context focused on what matters for its role.

To see which rules apply to a specific agent, look at the flow state that spawns it in `flows/` and trace what context fragments the orchestrator injects.

## Adding a New Rule

Name the file `agent-{behavior-name}.md`. Write a clear, actionable constraint statement — if you can't state the rule as an imperative in one sentence, it's probably not specific enough to be a rule. Add the rule to the relevant flow states where it should be enforced.

If the constraint is about code properties rather than agent behavior, it belongs in `principles/` instead.
