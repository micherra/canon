---
id: agent-discovery-execution-pairing
title: Discovery and Execution Are Paired Obligations
severity: rule
tags: [agent-behavior, quality-gates]
---

When an agent definition includes a section for discovering a quality gate (test command, lint command, build command), it MUST also include a section for executing that discovered gate in the same flow. Discovery without execution is an incomplete contract.

## Rule

If your agent instructions contain a step that discovers or identifies a quality gate command — by scanning for config files, running detection heuristics, or reading workspace metadata — you MUST also have a step that executes the discovered command before reporting your terminal status.

The two steps must appear in the same flow (not split across modes, or delegated silently to a downstream agent without explicit handoff instructions).

## Rationale

NF-14 showed that agents discovered artifacts to write but weren't told to write them, causing cascading pipeline failures. NF-18 revealed the same pattern for quality gates: the tester and reviewer both had sections for discovering lint/test commands but neither was explicitly instructed to execute them in the same flow.

Two occurrences of this discovery-without-execution gap in 12 soak runs indicates it is a systematic contract failure, not an incidental omission. When an agent definition pairs the two obligations explicitly, the failure mode is eliminated regardless of model behavior.

## Examples

**Bad — agent discovers a lint command but never executes it:**

```markdown
## Discover Lint Gate

Check for `.eslintrc*` or `eslint.config.*`. If present, record
`{ command: "npx eslint .", source: "reviewer" }` in your report.

## Stage 4: Drift-from-Plan Check

Compare changed files to the architect plan...
```

The lint command is recorded but never run. The gate exists only on paper.

**Good — agent pairs discovery with execution:**

```markdown
## Discover Lint Gate

Check for `.eslintrc*` or `eslint.config.*`. If present, record
`{ command: "npx eslint .", source: "reviewer" }` in your report.

## Build and Lint Verification

After completing all review stages:

1. Run `npm run build` to verify the build is clean.
2. Run each command discovered in the Lint Gate section above.
3. Report any failures as BLOCKING findings.
```

Discovery and execution are both present and explicitly linked.

## Exceptions

Agents that intentionally do not execute certain gates due to scope constraints MUST document the intentional omission in their agent definition. Acceptable reasons to omit execution:

- **Code-analysis-only agents** (e.g., security): scope is static analysis of source code, not build health. Running builds would mix concerns and extend scan time without improving findings quality. Document with a note: "Intentional omission: this agent does not run build or lint — scope is static code analysis only."
- **Pre-implementation agents** (planner, architect): these agents produce artifacts (briefs, runbooks, task plans, design documents) but operate before build artifacts exist. They have no build to run gates against.
- **Synthesis agents** (shipper, scribe): their role is to read artifacts and produce documentation, not to verify build health. The build was already verified by tester and reviewer.

An intentional omission without documentation is indistinguishable from an accidental gap — and will be flagged as a violation in future audits.
