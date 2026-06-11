# Codex Defect Classes — Frequency-Ranked Evidence

> **Mine command**: `bash scripts/mine-codex-comments.sh`
> **Re-run cadence**: Quarterly, or when the corrective-build rate ticks up (>20% of recent builds are "address-codex" rework).
> **Upgrade trigger**: If the ranked class order shifts significantly across two consecutive re-runs, consider promoting the top volatile class to a standing learner dimension (per codex-preempt-04 Decision D4).
> **Source**: Every `chatgpt-codex-connector[bot]` review comment across merged PRs #47+ (the Codex-activation window).

## Ranked Defect Classes

| Rank | Class | Comments | of which P1 | Score (P1×2 + P2×1) |
|------|-------|----------|-------------|---------------------|
| 1 | **path/dir resolution** (class 2) | 34 | 16 | 50 |
| 2 | **validation / guard bad-or-missing input** (class 4) | 35 | 6 | 41 |
| 3 | **board/state persistence & ordering** (class 1) | 19 | 12 | 31 |
| 4 | **scope/boundary too broad-or-narrow** (class 3) | 19 | 6 | 25 |
| 5 | **shell/git tokenize & eval safety** (class 5) | 10 | 8 | 18 |
| 6 | **grep/awk/regex/fence boundary** (class 6) | 11 | 3 | 14 |
| 7 | **tool-wiring (schema/args/call)** (class 8) | 6 | 3 | 9 |
| 8 | **concurrency / transaction / race** (class 7) | 3 | 3 | 6 |
| 9 | **return-shape / empty handling** (class 9) | 1 | 0 | 1 |

## Per-Class Details

### Class 2: path/dir resolution

**Comments**: 34 total (16 P1, 18 P2) | **Score**: 50

**Encoding**: PROMPT + light grep hint — judgment on project-root vs plugin-dir resolution; grep hint for ESM `__dirname`/`import.meta` and hardcoded `CANON_PROJECT_DIR`.

**Sample findings**:

- *Avoid chmod-only unreadable-dir fixtures*
- *Use an ESM-safe directory reference*

### Class 4: validation / guard bad-or-missing input

**Comments**: 35 total (6 P1, 29 P2) | **Score**: 41

**Encoding**: PROMPT — judgment: raise/return on missing state, verify-before-act, robust-to-concurrent-init.

**Sample findings**:

- *Respect since filters for cliff events*
- *Require a separator before starting tables*

### Class 1: board/state persistence & ordering

**Comments**: 19 total (12 P1, 7 P2) | **Score**: 31

**Encoding**: PROMPT — judgment: wave-gate precedence, finalize/terminal-state transitions, flow-event override ordering, read-before-write on board state.

**Sample findings**:

- *Include working-tree edits in finalize diff stats*
- *Do not mark spawn enrichment as fully shipped*

### Class 3: scope/boundary too broad-or-narrow

**Comments**: 19 total (6 P1, 13 P2) | **Score**: 25

**Encoding**: PROMPT — judgment: is a guard/exception/pathspec scoped to exactly its declared surface?

**Sample findings**:

- *Check the session is still active before registering scope*
- *Include scope-parity warnings in the verdict rules*

### Class 5: shell/git tokenize & eval safety

**Comments**: 10 total (8 P1, 2 P2) | **Score**: 18

**Encoding**: GREP — diff-deterministic flag for string-executing wrappers (`eval`, `bash -c`, `sh -c`) over interpolated variables.

**Sample findings**:

- *Block quoted git passed to shell evaluators*
- *Strip command prefixes before resolving git subcommands*

### Class 6: grep/awk/regex/fence boundary

**Comments**: 11 total (3 P1, 8 P2) | **Score**: 14

**Encoding**: GREP — flag unanchored frontmatter `awk`/`grep` patterns; short fences around embedded prompts.

**Sample findings**:

- *Bound the frontmatter grep to the tools field*
- *Use the verdict from the matched violation review*

### Class 8: tool-wiring (schema/args/call)

**Comments**: 6 total (3 P1, 3 P2) | **Score**: 9

**Encoding**: NOT WIRED — already covered by reviewer Stage 2 "Agent to Tool Reachability" and "Discriminant Surface Parity". Wiring again is redundant. Listed here so a re-miner sees it is handled.

**Sample findings**:

- *Expose craft_profile through store_pr_review*
- *Bump run-summary schema version for field removal*

### Class 7: concurrency / transaction / race

**Comments**: 3 total (3 P1, 0 P2) | **Score**: 6

**Encoding**: PROMPT — judgment: serialize board read+write, same-transaction reads, atomic init, session-scoped jobs.

**Sample findings**:

- *Remove blanket disable for active UI principles*
- *Avoid reusing active workspace for truncated-slug collisions*

### Class 9: return-shape / empty handling

**Comments**: 1 total (0 P1, 1 P2) | **Score**: 1

**Encoding**: NOT WIRED — below noise cut (lowest volume, P1=1). Listed for completeness; revisit if a re-run re-ranks it higher.

**Sample findings**:


## Mining Metadata

- PRs in window: 276
- Raw Codex comment rows: 234
- Parsed badge comments: 233
- Unclassified: 95
- Mine date: 2026-06-08
