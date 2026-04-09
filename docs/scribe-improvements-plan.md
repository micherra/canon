# Scribe Improvements Plan

Status: Proposed | 2026-04-08

---

## Problem Statement

CLAUDE.md files and project documentation drift or never get created. The scribe agent runs infrequently, has limited codebase awareness, and makes conservative classification decisions that default to "skip."

## Root Causes

### 1. Trigger Gap

The scribe only runs in flows that include the `context-sync` fragment (`feature`, `epic`, `refactor`, `migrate`). `fast-path` has no `context-sync` state at all. Most bug fixes and small improvements go through `fast-path` and never invoke the scribe. Documentation drifts not because the scribe fails — but because it never runs.

### 2. Awareness Gap

The scribe receives only the git diff and implementor summaries. It has no knowledge of:
- Which directories exist and which have (or should have) CLAUDE.md files
- The overall module structure and what constitutes a distinct subsystem
- Whether a given change is the 10th modification to a hot file with stale docs

Creating subdirectory CLAUDE.md files requires answering "does this module warrant its own file?" — a question the scribe can't answer from a diff alone.

The scribe also depends on implementor summaries that degrade in quality exactly when changes are most complex (stuck, near convergence limit, DONE_WITH_CONCERNS).

### 3. Model Gap

Sonnet running the scribe makes "is this contract-level?" judgment calls that are genuinely hard. Boundary cases (exported helpers, renamed types used across modules) get classified as "internal, skip." CLAUDE.md drift is almost entirely a sin of omission — the scribe never adds wrong things, it fails by not adding things it should.

---

## Proposed Improvements

### Phase 1: Coverage and Awareness (buildable now)

#### 1a. Add `context-sync` to `fast-path`

Single-line YAML change. The `skip_when: no_contract_changes` predicate handles the common case of internal-only changes cheaply — the scribe exits fast on non-contract changes. The cost of spawning and quickly exiting is low. The cost of missing a contract change is permanent drift.

**Files:** `flows/fast-path.yaml`, `flows/fragments/context-sync.yaml` (verify skip_when predicate)

#### 1b. Module Discovery Pass

Add a step to the scribe's process: before classifying the diff, do a lightweight `Glob` scan to find directories with code but no CLAUDE.md. Flag gaps proactively instead of only reacting to diffs. The scribe already has `Glob` in its tool list.

Discovery criteria:
- Directory contains 5+ `.ts` files (or language-appropriate equivalent)
- No `CLAUDE.md` or `.claude/CLAUDE.md` exists
- Directory is not under `__tests__/`, `node_modules/`, or `.canon/`

When gaps are found, create stub CLAUDE.md files with basic module description derived from file names and exports.

**Files:** `agents/canon-scribe.md` (add Step 0: Module Discovery before Step 1: Read the diff)

#### 1c. Code-to-Docs Mapping (`doc-map.yaml`)

Explicit mapping from source directories to documentation files. Human-maintained, scribe-consumed.

```yaml
# .canon/doc-map.yaml
mappings:
  - source: mcp-server/src/features/orchestration/
    docs:
      - CLAUDE.md                          # project root
      - docs/reference/canon-reference.md
  - source: mcp-server/src/graph/
    docs:
      - mcp-server/.claude/CLAUDE.md
  - source: flows/
    docs:
      - CLAUDE.md
      - docs/reference/canon-reference.md
  - source: agents/
    docs:
      - CLAUDE.md
  - source: principles/
    docs:
      - CLAUDE.md
```

The scribe reads this mapping in Step 1 and uses it to determine which docs to check when the diff touches a mapped directory. Eliminates inference from first principles.

**Files:** `.canon/doc-map.yaml` (new), `agents/canon-scribe.md` (reference doc-map in Step 1)

#### 1d. Pre-Classification Before Spawn

Move "is this contract-level?" out of the scribe's reasoning. The orchestrator (or a lightweight pre-check in the `context-sync` state's `skip_when` logic) does mechanical grep on the diff before spawning:

- Exported function signature changes (`export function`, `export const`, `export type`, `export interface`)
- New route/endpoint definitions
- Schema/migration changes
- Dependency changes (`package.json`, `import` additions)
- New file creation in mapped directories

Pass pre-classified results to the scribe so it doesn't re-derive the same information. This addresses the model gap — mechanical detection handles obvious cases, leaving genuine judgment calls to the agent.

**Files:** `flows/fragments/context-sync.yaml` (enhance skip_when), `agents/canon-scribe.md` (accept pre-classified file list)

### Phase 2: Intelligence Signals (after git intelligence layer)

#### 2a. Hotspot-Aware Documentation

When the scribe processes a diff that touches a hotspot file (high churn x complexity from Phase 1 git intelligence), it receives that signal via ADR-008's context assembly pipeline. Hotspot files get extra documentation attention — the scribe should verify their CLAUDE.md entries are thorough, not just present.

#### 2b. Co-Change Partner Checking

When the diff modifies file A but not file B, and A-B are co-change partners (Jaccard >= 0.3), the scribe warns: "File A was modified but its frequent co-change partner B was not. Verify documentation for B is still accurate."

#### 2c. Doc Staleness as Drift Dimension

Add documentation freshness to `get_drift_report`:
- Track `last_sync_commit` per CLAUDE.md file
- Compute commits-since-sync for the corresponding directory
- Surface in drift reports alongside principle compliance scores
- Confidence decay: start at 1.0 after sync, decay per commit (x0.9), per week (x0.95)

**Files:** `mcp-server/src/features/diagnostics/` (add doc staleness to drift report), `mcp-server/src/platform/storage/drift/` (schema for doc sync tracking)

### Phase 3: Proactive Maintenance (future)

#### 3a. SessionStart Doc Health Check

Inspired by ClaudeForge's Guardian Agent pattern. On session start, load doc staleness scores. If any CLAUDE.md has confidence below threshold (0.5), surface a brief notice: "3 documentation files may be stale." Not blocking — advisory only.

#### 3b. Quality Scoring

Rate CLAUDE.md files on completeness (0-100) across dimensions:
- Completeness: all documented modules have entries
- Freshness: last-updated timestamps within threshold
- Specificity: entries describe concrete contracts, not vague descriptions
- Coverage: ratio of exported symbols documented vs. total exports

Surface scores in drift reports and SessionStart health checks.

#### 3c. PostCompact Narrative Capture

From clauditor-lessons.md Feature 1. Register a `PostCompact` hook that appends compaction summaries to `progress.md`. The scribe incorporates these during context-sync to avoid losing agent reasoning at compaction boundaries.

---

## Sequencing

| Item | Effort | Impact | Dependencies |
|------|--------|--------|-------------|
| 1a. fast-path context-sync | Tiny | High | None |
| 1b. Module discovery | Small | Medium | None |
| 1c. doc-map.yaml | Small | High | None |
| 1d. Pre-classification | Medium | High | None |
| 2a. Hotspot-aware docs | Small | Medium | Git intelligence Phase 1 |
| 2b. Co-change checking | Small | Medium | Git intelligence Phase 1 |
| 2c. Doc staleness drift | Medium | High | Git intelligence Phase 1 |
| 3a. SessionStart health | Small | Medium | 2c |
| 3b. Quality scoring | Medium | Medium | 1b, 1c |
| 3c. PostCompact capture | Small | Medium | Confirm PostCompact hook availability |

**Recommended first build:** Items 1a-1d as a single `feature` flow. They address different root causes, are independently valuable, and have zero infrastructure dependencies.

---

## External Inspiration

| Source | Key Pattern | Canon Application |
|--------|------------|-------------------|
| [ClaudeForge](https://github.com/alirezarezvani/ClaudeForge) | Guardian Agent with SessionStart hooks, quality scoring | Phase 3a, 3b |
| [Dosu Blog](https://dosu.dev/blog/how-to-catch-documentation-drift-claude-code-github-actions) | Code-to-docs mapping table, PR-triggered drift detection | Phase 1c (doc-map.yaml) |
| [Victor Sowers](https://www.linkedin.com/pulse/your-claude-code-repository-forgets-what-knows-mine-doesnt-sowers-3dble/) | SessionStart state loading, weekly audit pattern, KG typed edges | Phase 3a, broader Canon learning |
| [claude-md-templates](https://github.com/abhishekray07/claude-md-templates) | 80-line attention budget, progressive disclosure, self-improvement loop | CLAUDE.md authoring guidelines |

## Relationship to Other Work

- **Git Intelligence Phase 1** (hotspot + co-change): Provides the temporal signals Phase 2 consumes
- **Codebase Intelligence Roadmap**: Phase 2 (confidence decay) directly feeds 2c
- **Clauditor Lessons**: Feature 1 (PostCompact) is item 3c; Feature 3 (loop detection) is independent
- **ADR-008** (context assembly): Already implemented — the delivery vehicle for Phase 2 signals exists
