---
id: disk-is-source-of-truth-on-resume
title: Unit-Loop Agents Externalize Progress Durably and Reconcile on Resume
severity: convention
scope:
  layers: []
  file_patterns:
    - "agents/**"
    - "rules/**"
    - "principles/**"
    - "references/**"
    - "CLAUDE.md"
tags: []
---

A long-running agent that iterates over a list of units — files, patterns, test cases — and is long enough to risk mid-run context compaction MUST externalize each completed unit durably as it goes and MUST reconcile its own durable progress against its output before re-doing work on resume. Disk is the source of truth; the conversation is not.

## The Two-Phase Invariant

**Phase 1 — Write the output for a unit FIRST, then advance the cursor.**

Do not hold completed-unit state only in conversation memory. Externalize immediately using one of:

- A git `wip` commit containing the completed unit's changes
- An append to a JSONL file (one object per line = one unit per line)
- An incremental write to the shared artifact (e.g., append file findings to REVIEW.md and update a `processed_units[]` cursor field)

The worst-case loss on a context compaction event that happens between units is exactly ONE unit — the one currently in progress — not the whole run.

**Phase 2 — On resume, read the cursor from disk before re-doing work.**

Before restarting a loop, read what is already on disk:

- `git diff --name-only <base>..<HEAD>` — which files are already committed
- Tail of the JSONL file — which pattern ids are already emitted
- The `processed_units[]` frontmatter in the shared artifact — which units are already written

Skip units whose output already exists on disk. Do not re-run them.

## Scope

**Applies to:** unit-loop agents whose run time is long enough to risk mid-run context compaction. Signals: iterates over 5+ units, multi-stage processing, expected to consume significant context budget (engineer on large plans, reviewer on large diffs, learner mining many patterns).

**Does NOT apply to:**
- Short single-shot agents that don't loop over units (scribe, shipper — their single artifact is covered by `agent-artifact-write-before-return` at the whole-artifact level)
- Step-level orchestrator reconciliation — that is `reconcile_workspace`'s job, which operates at step granularity from outside the agent

## Reference Implementations

| Agent | "Write first" (output unit) | "Advance cursor" | Resume reconcile |
|-------|-----------------------------|------------------|------------------|
| **engineer / DAG worker** | `wip({task-id})` git commit per passing unit | `git diff --name-only <base>..<HEAD>` | Re-spawn Enrichment Protocol: committed files → "do NOT re-implement"; uncommitted → commit first |
| **learner** | one JSONL object appended to `learning.jsonl` | implicit (last line written = cursor position) | on resume, read JSONL tail; skip already-emitted pattern ids |
| **reviewer (target state)** | per-file findings block appended to REVIEW.md | `files_reviewed[]` frontmatter list in REVIEW.md | on resume, read `files_reviewed[]`; diff files not in list = not yet reviewed; restart there |

The engineer and DAG worker already fully implement this convention via git. The learner already uses the JSONL pattern. The reviewer's target state (per-file incremental write + cursor) is the primary gap this convention names.

## Relationship to Adjacent Principles

**`agent-artifact-write-before-return`** — that rule governs write obligation at artifact granularity (the whole artifact must land before the agent returns its terminal status). This convention is the finer-grained sibling: it governs write obligation at unit granularity within the agent's loop. They compose without contradiction: write each unit to disk as you go (this convention), and write the complete artifact before returning (that rule).

**`agent-budget-checkpoint`** — that strong-opinion governs checkpoint writes at 50%/75% of the turn budget (time-based). This convention governs checkpoint writes at unit boundaries (event-based). They are complementary: a budget checkpoint is a fallback for agents without a unit cursor; a unit cursor is strictly stronger because loss is bounded to one unit instead of a full 50%/75% interval.

**`reconcile_workspace`** — the orchestrator tool that detects write-cliffs at step granularity (missing or partial artifacts at step boundaries). This convention is the *intra-artifact complement*: it defines what the agent must do inside its own loop so that the step-level artifact is always in a resumable state. They compose: `reconcile_workspace` detects that REVIEW.md carries `verdict: IN_PROGRESS`; this convention tells the reviewer how to pick up from the last-reviewed file without re-running the whole review.

## Examples

**Good — engineer commits per passing unit:**

```
# Engineer in impl loop:
[implements feature in file A]
[tests pass]
git commit -m "wip(task-1): implement A" --trailer "Canon-Workflow: ..."
[implements feature in file B]
[tests pass]
git commit -m "wip(task-1): implement B" --trailer "Canon-Workflow: ..."

# If the agent is re-spawned mid-loop:
git diff --name-only <base>..HEAD
# → A is committed; only B needs re-doing
# Re-spawn Enrichment Protocol: "file A does NOT need re-implementation"
```

**Good — learner appends per pattern:**

```
# Learner mining patterns:
[analyzes watch file 1, finds pattern P1]
append {"id": "P1", "file": "...", ...} to learning.jsonl
[analyzes watch file 2, finds pattern P2]
append {"id": "P2", "file": "...", ...} to learning.jsonl

# If resumed:
tail learning.jsonl → last id = "P2"
Skip P1 and P2; resume from watch file 3
```

**Bad — reviewer holds all per-file findings in conversation memory:**

```
# Reviewer in Stage 1 loop, no per-file disk write:
[reviews file A — findings in context only]
[reviews file B — findings in context only]
[reviews file C — context compaction event]
→ all per-file findings lost; cold-review re-run from scratch

# On re-spawn, forced to re-review all files from the beginning
```

**Good — reviewer writes per-file findings incrementally:**

```
# Reviewer in Stage 1 loop, per-file write:
[reviews file A]
append A findings to REVIEW.md; update files_reviewed: [A]
[reviews file B]
append B findings to REVIEW.md; update files_reviewed: [A, B]
[context compaction event]

# On resume:
read REVIEW.md files_reviewed: [A, B]
diff files not in list → [C, D, E] → resume from C
# Loss bounded to one unit (C was in progress)
```

## Exceptions

- Agents that process a single unit per session (no loop) are exempt — the whole-artifact write obligations of `agent-artifact-write-before-return` cover them.
- Agents whose full run fits well within a single context window (very short loops, e.g., 2–3 trivially small units) may omit the per-unit cursor if the budget-checkpoint writes at 50%/75% already provide adequate coverage. When in doubt, prefer per-unit writes.
- When the durable store is unavailable (e.g., no write access to the git worktree), fall back to in-memory state with a note in the artifact that the run is not resumable.

## Anti-Rationalization

| Excuse | Why It's Wrong | Correct Action |
|--------|---------------|----------------|
| "Context compaction is rare — I won't bother." | Compaction frequency is not measured per agent. A single large diff or large pattern set is enough to trigger it. Durable writes cost one tool call per unit; a cold re-run costs a full session. | Write the unit to disk before advancing the cursor. |
| "The orchestrator's `reconcile_workspace` covers this." | `reconcile_workspace` detects step-level write-cliffs — missing or partial artifacts at step boundaries. It cannot tell which file of a 20-file review was last processed. | The agent's own cursor is the only mechanism that knows intra-artifact progress. |
| "I'll write everything at the end." | A context compaction mid-loop produces either (a) nothing, if the agent exits before the final write, or (b) a complete artifact from whatever the agent remembered — which may be wrong. | Write each unit's output before advancing to the next unit. |
| "The budget checkpoint at 50% covers me." | Budget checkpoints are time-based (50% of turns). For a long-running reviewer, 50% of turns may represent 5 of 10 files reviewed — losing 5 files of work. A per-file cursor bounds loss to 1 file. | Use per-unit writes when a cursor is feasible. |

## Verification

```bash
# Confirm the principle file exists:
test -f principles/conventions/disk-is-source-of-truth-on-resume.md && echo "EXISTS"
```

Expected: `EXISTS` — zero other convention files should cover intra-agent unit-loop checkpointing at this granularity.
