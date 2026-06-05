---
id: line-limit-split-into-siblings
title: Extract Cohesive Siblings When a File Crosses the Line Limit
severity: convention
scope:
  layers: []
  file_patterns:
    - "mcp-server/src/**/*.ts"
tags:
  - architecture
  - file-organization
  - modules
  - single-responsibility
---

When a file crosses the 600-line `noExcessiveLinesPerFile` limit, extract cohesive units as sibling files in the same directory. Do not add a barrel re-export in the original file. Update every import site in production and test code to reference the new sibling directly.

## Rationale

The 600-line limit is a proxy for accumulated responsibility. When a file reaches it, the correct response is to identify a genuine cohesion boundary and extract along it — not to trim whitespace, collapse comments, or dump types into a catch-all file. See `refactoring-integrity` for the full treatment of what constitutes a valid decomposition.

**Why no barrel re-export.** Adding `export { … } from './sibling'` in the original file defeats the extraction's modularity benefit: the original file becomes a hub again, callers remain decoupled from the boundary you just drew, and the `noBarrelFile` Biome rule fires. Without a barrel, callers explicitly name which cohesive unit they depend on. The ~N import-site updates are part of the same task, not optional cleanup.

**How to pick the cohesion boundary.** The extraction boundary must be expressible in one sentence describing what the sibling "owns" — without using "and." Confirmed patterns from this codebase:

- **By data layer:** row types + deserializers in one file (no logic, no I/O); factory function + cache lifecycle in another.
- **By responsibility domain:** craft-drift scoring logic in one file; cross-run pattern detection in another.

If you cannot write the one-sentence description, the boundary is wrong. If the result would sit within 5% of the 600-line limit (570–600 lines), the split is incomplete.

**Verification obligation.** After extraction: the original file is below the limit, each new sibling is well under the limit from birth, and `grep -rn "export.*from './sibling'"` in the original file returns nothing.

## Examples

**Bad — file exceeds limit; "fixed" by adding a barrel re-export:**

```typescript
// drift-db.ts — 767 lines after evictDriftDbForScope was added

// Attempted fix: extract to drift-db-rows.ts but keep a barrel in drift-db.ts
// so no callers need updating
export { DriftDbRow, DriftDbCache, deserializeDriftRow } from "./drift-db-rows";
// drift-db.ts is still 640 lines; callers still import from "drift-db"
// noBarrelFile fires; the module boundary is invisible to callers
```

**Good — cohesive siblings extracted, callers updated, no barrel (drift-db.ts split, PR #304):**

```typescript
// drift-db-rows.ts — "Owns the SQLite row shapes and deserializers for the drift store"
// ~80 lines. No I/O. No factory logic.
export interface DriftDbRow { id: string; scope: string; payload: string; created_at: number; }
export interface DriftDbCache { db: Database; scopeKey: string; }
export function deserializeDriftRow(raw: DriftDbRow): DriftEntry { … }

// drift-db-cache.ts — "Owns the getDriftDb factory and eviction lifecycle"
// ~110 lines. No row shape definitions. No deserializers.
export function getDriftDb(scopeKey: string): Database { … }
export function evictDriftDbForScope(scopeKey: string): void { … }

// drift-db.ts — "Manages drift persistence query operations"
// 574 lines (down from 767). Imports siblings directly; no barrel re-exports.
import type { DriftDbRow } from "./drift-db-rows";
import { deserializeDriftRow } from "./drift-db-rows";
import { getDriftDb } from "./drift-db-cache";

// All ~20 former callers of drift-db were updated to import from the sibling
// that owns what they actually need:
//   import { getDriftDb } from "./drift-db-cache";      ← was: from "./drift-db"
//   import type { DriftDbRow } from "./drift-db-rows";  ← was: from "./drift-db"
```

**Good — three-way split under merge inflation (cross-run-analyzer.ts split, PR #306):**

```typescript
// cross-run-analyzer.ts grew to 803 lines when main's craft-drift code merged
// onto a branch that already carried the JUDGE logic.

// cross-run-craft-drift.ts — "Scores craft-drift dimensions across run history"
// cross-run-patterns.ts   — "Detects recurring error and fix patterns across runs"
// cross-run-analyzer.ts   — "Orchestrates cross-run analysis" (down to 467 lines)

// Each caller imports the sibling it actually needs — no barrel in cross-run-analyzer.ts.
import { scoreCraftDrift } from "./cross-run-craft-drift";
import { detectRecurringPatterns } from "./cross-run-patterns";
```

**Confirmed instances in this codebase:**

| File | Before → After | Split axis | Build |
|------|---------------|-----------|-------|
| `register-knowledge.ts` | 614 → split | Registration handlers vs tool implementations | PR #290 |
| `drift-db.ts` | 767 → 574 | Row types + deserializers vs factory + eviction | PR #304 |
| `cross-run-analyzer.ts` | 803 → 467 | Craft-drift scoring vs pattern detection vs orchestration | PR #306 |
| HTTP epic 1b (unnamed) | pre-existing violation → split | — | HTTP epic 1b |

## Exceptions

When a file grows past the limit due to generated code, test fixtures, or a large lookup table that cannot be meaningfully split by responsibility, the extraction obligation does not apply — but the reason must be documented in a comment at the top of the file. Example: a hand-maintained SQL migration file or an exhaustive unicode normalization table.

If the file contains a single large function or class that cannot be decomposed without breaking its contract (e.g., a protocol-mandated interface implementation), split what can be split and document what cannot in the PR description.

## Anti-Rationalization

| Excuse | Why It's Wrong | Correct Action |
|--------|---------------|----------------|
| "I'll add a barrel re-export so callers don't need updating." | The barrel makes the original file a hub again, defeats the module boundary, and violates `noBarrelFile`. Callers must name their dependency explicitly. | Update every import site. The grep command above confirms completeness. |
| "The sibling is just a types file — types don't need their own module." | Row types + deserializers form a cohesive data-layer unit. A types dump with no bounded identity is a `refactoring-integrity` violation. | The sibling must own a describable responsibility; types that belong together because they are consumed together count. |
| "The file is at 595 lines — close enough." | Within 5% of the limit after a split is a signal that the file was trimmed rather than genuinely decomposed. | Continue the extraction until the original file is comfortably below the limit with no whitespace manipulation. |
| "Updating 20 import sites is out of scope for this task." | The caller update obligation is part of the same task. An extraction that leaves callers importing from a barrel is not complete. | Budget the import-site grep and update into the task estimate before starting. |

## Verification

- [ ] The original file is below 600 lines after extraction with no whitespace-only edits.
- [ ] Each new sibling file is well under 600 lines from birth (not within 5% of the limit).
- [ ] No `export { … } from './sibling'` barrel re-export exists in the original file.
- [ ] Every import site in production and test code that previously imported the extracted symbols has been updated to import from the new sibling directly.
- [ ] Each sibling file can be described in one sentence without "and" — write that sentence in a comment at the top of the file.
- [ ] Any deviation from this convention is documented under `## Exceptions` with a bounded rationale.

**Related:** `refactoring-integrity` — the decomposition must follow genuine responsibility boundaries, not cosmetic trimming. `noBarrelFile` (Biome lint rule) — re-export prohibition that this convention enforces at the architectural level. `compute-effect-separation` — the intra-file variant of the same single-responsibility principle, applicable before a file reaches the line limit. `functions-do-one-thing` — the function-level responsibility rule whose module-level analog this convention standardizes.
