---
id: removal-sweep-includes-prose
title: Removal Sweeps Must Include Prose Operating Documents and Agent Instruction Files
severity: convention
portable: false
scope:
  file_patterns:
    - "agents/*.md"
    - "rules/*.md"
    - "skills/**"
    - "references/*.md"
    - "docs/**"
    - "CLAUDE.md"
    - "**/CLAUDE.md"
    - "CONTEXT.md"
    - "mcp-server/**/*.md"
tags:
  - process
  - documentation
  - dead-code
---

When a removal PR deletes a tool, feature, or symbol, the removal (or an immediate follow-up PR) MUST grep every in-scope prose surface for the removed name and correct every reference that instructs an agent to call or use the removed entity — not just code-level references.

## Rationale

Removal PRs routinely sweep code (constant arrays, type declarations, directory-path strings) but leave agent instruction files and operating documentation behind. Prose references that instruct an agent to call a removed tool produce tool-not-found errors at invocation time — a worse failure than a stale code comment, because it fires during a live agent run rather than at compile time.

**Instance 1 (`sug_EE2`, messaging-layer removal, PR #180).** A dead-messaging-infra removal left agent instructions referencing the removed messaging path.

**Instance 2 (PR #277, `fix-stale-removed-tool-docs`).** A sweep of 22 files that had been drifting for 119 commits since PR #151 (2026-05-05) removed four MCP tools. Several files contained agent instructions *telling agents to call the removed tools*.

**Instance 3 (PR #443 REVIEW-2 advisory fix, commit `f8ea6d83`).** `agents/reviewer.md` still said "Planner" in 9 places (headers, taxonomy mapping, a table column) months after the `canon:planner` agent was retired (#206). This is a variant of the core shape — a deleted *agent name* left in descriptive prose in a sibling agent-definition file, rather than a deleted tool/symbol reference — but the same underlying defect: a removal sweep that covered code did not cover prose.

This proposal previously decayed on 2026-06-12 with no promotion action taken (`consolidate_disposition: decay`). Instance 3 reopened it as a 3rd occurrence across roughly seven weeks, meeting the promotion threshold.

## In-Scope Surfaces

- `agents/*.md` — agent instruction files (highest priority: broken agent instructions cause tool-not-found errors at invocation time)
- `rules/*.md` and `skills/**` — agent-behavior rules and skill definitions
- `references/*.md` — orchestrator protocol fragments
- `docs/**` — operating documentation
- `CLAUDE.md`, `CONTEXT.md` — top-level operating contracts
- `mcp-server/**/*.md` — feature-layer READMEs and CLAUDE.md files

## Exempt Surfaces

- Historical or dated artifacts: `.ai/`, `.spike/`, dated review files (e.g., `reviews/REVIEW-*.md`) — a past-tense reference to something that has since been removed is legitimate historical record, not a broken instruction.
- Fixture or label uses: string constants used as arbitrary test labels, not instructions.

## Detection

Run `git grep -l <removed-name>` across the in-scope surfaces immediately after the removal commit. Classify each hit as **stale-correct** (needs the reference updated to point at the replacement), **stale-delete** (the reference should be removed entirely), or **legitimate-keep** (historical record or an unrelated token collision) before the removal PR merges, or in the very next immediate follow-up PR.

**Crucial CWD caveat**: run the grep against the branch/worktree that will actually merge, not an unrelated snapshot of `main`. A grep run against the wrong tree can report a stale hit that the removal PR already fixed on its own branch — treat any "still hits" finding as provisional until confirmed against the actual merge target's HEAD.

## Examples

**Bad — code swept, prose left behind:**

```example
# Removal PR deletes `get_cross_run_analysis` tool + its registration.
# agents/learner.md still lists it under `tools:` — untouched.
# Next learner invocation: tool-not-found error at runtime.
```

**Good — prose swept in the same PR:**

```example
# Removal PR deletes `get_cross_run_analysis` tool + its registration,
# AND greps agents/*.md, rules/*.md, references/*.md, CLAUDE.md for the
# tool name, finding and removing the stale `tools:` entry in
# agents/learner.md in the same commit.
```

**Bad — agent-name retirement swept in one file, not its sibling:**

```example
# canon:planner agent retired; agents/architect.md updated to remove
# planner handoff language, but agents/reviewer.md's taxonomy table
# still lists "Planner" as an active agent type in 9 places.
```

## Exceptions

- A removal PR may explicitly scope itself to code-only cleanup when the prose sweep is tracked as a named, immediate follow-up task with an owner and a due date — but the follow-up must land before the next release, not indefinitely deferred.
- References inside `.ai/`, `.spike/`, or dated review files documenting what a build *used to do* are legitimate-keep and require no action.

## Anti-Rationalization

| Excuse | Why It's Wrong | Correct Action |
|--------|---------------|----------------|
| "I already deleted the code — the docs are just stale text." | Agent instruction files are not passive documentation; agents read and act on them. A stale `tools:` entry or call-out produces a runtime tool-not-found error, not just a reader's confusion. | Grep the in-scope prose surfaces for the removed name in the same PR. |
| "It's just one mention in a table — low risk." | Instance 3 showed a single-agent retirement left 9 stale mentions in one sibling file; volume does not correlate with how easy a hit is to miss without a deliberate grep pass. | Run `git grep -l <removed-name>` across all in-scope surfaces; do not rely on incidental discovery. |
| "The removal PR is big enough already — prose cleanup is a nice-to-have follow-up." | Follow-ups without an owner and a deadline decay (this exact proposal decayed once already on 2026-06-12). | If deferring, name an owner and a due date for the prose sweep; otherwise do it now. |

## Verification

- [ ] `git grep -l <removed-name>` was run across every in-scope surface (`agents/`, `rules/`, `skills/`, `references/`, `docs/`, `CLAUDE.md`, `CONTEXT.md`, `mcp-server/**/*.md`) after the removal commit.
- [ ] Every hit is classified as stale-correct, stale-delete, or legitimate-keep, with stale-correct/stale-delete hits fixed before merge (or tracked as a named, dated follow-up).
- [ ] No agent instruction file (`agents/*.md`) still instructs an agent to call or use the removed entity.
- [ ] The grep was run against the actual merge-target branch/worktree HEAD, not an unrelated snapshot of `main`.

## Relationship to `incomplete-dead-code-removal`

This convention supersedes the ghost principle ID `incomplete-dead-code-removal` (observed in the drift store with 3 violations and 0% compliance, but no principle file on disk — an unreferenceable ID). This convention covers the same structural class — removal leaves references behind — for both code and prose surfaces. Retiring the ghost drift-store entries is a separate, non-file operation for the orchestrator to perform; it is not accomplished by adding this file.
