# Drift/Review Bounded Context — Interface Directory

This directory contains the **interface contract** for the Drift/Review bounded context. It is the anti-corruption layer between the Drift context and any consumer that needs access to review persistence or compliance analytics.

## What This Context Owns

The `domains/drift/` directory owns the **capability interface** — the typed contract that cross-context callers depend on. Specifically:

- **`IDriftStore`** — the single interface that consumers (primarily `features/orchestration/`) import to access review persistence and compliance trend capabilities.
- The anti-corruption layer role: consumers never know whether reviews are backed by SQLite, a file store, or anything else. The interface is what they depend on.

The broader Drift/Review context also owns (in other directories):
- Review persistence and retrieval (`platform/storage/drift/`)
- PR review storage (`features/pr-review/`)
- Compliance trend calculation and flow run analytics (`features/diagnostics/`)
- Violation tracking over time

## What This Context Does NOT Own

- **Concrete implementations**: `DriftStore` and `DriftDb` live in `platform/storage/drift/`, not here. This directory only holds the interface.
- **SQLite database management**: Schema migrations and connection pooling are in `platform/storage/drift/drift-schema.ts`.
- **Orchestration logic**: The Orchestration context drives when reviews are recorded and when compliance data is read. Drift only owns the store operations.
- **Flow types**: This context has no dependency on `domains/flows/` types.
- **Knowledge Graph data**: File indexing and structural metrics belong to the Knowledge Graph context (`graph/`).

## Public Interface

### `IDriftStore`

Defined in `drift-store.interface.ts`. All consumers import this type; no consumer imports `DriftStore` directly.

```typescript
interface IDriftStore {
  // Review retrieval — filter by principle, branch, or PR number (AND-filter)
  getReviews(options?: { principleId?: string; branch?: string; prNumber?: number }): Promise<ReviewEntry[]>;

  // PR-scoped queries
  getLastReviewForPr(prNumber: number): Promise<ReviewEntry | null>;
  getLastReviewForBranch(branch: string): Promise<ReviewEntry | null>;

  // Review persistence
  appendReview(entry: ReviewEntry): Promise<void>;

  // Compliance analytics
  getComplianceTrend(principleId: string, weeks?: number): Promise<WeeklyTrendPoint[]>;

  // File-based review lookup
  getReviewsForFiles(filePaths: string[]): Promise<ReviewEntry[]>;
}
```

### Key Types

| Type | Source | Purpose |
|------|--------|---------|
| `IDriftStore` | `domains/drift/drift-store.interface.ts` | Interface all consumers depend on |
| `ReviewEntry` | `shared/schema.ts` | Unified review record (principle reviews and PR reviews) |
| `WeeklyTrendPoint` | `platform/storage/drift/drift-db.ts` | Compliance pass rate and violation counts by ISO week |

`ReviewEntry` lives in the Shared Kernel (`shared/schema.ts`) rather than in this directory because both the Drift context and the Orchestration effects pipeline use it. It is a stable, cross-context type.

`WeeklyTrendPoint` is currently imported from `platform/storage/drift/drift-db.ts` because that is where it originates. A future refactor may move it into this directory if other consumers need it.

## Allowed Dependencies

This interface file has exactly two imports:

```typescript
import type { WeeklyTrendPoint } from "@platform/storage/drift/drift-db.ts";
import type { ReviewEntry } from "@shared/schema.ts";
```

This is intentional and bounded:
- `@shared/schema.ts` — Shared Kernel; always allowed.
- `@platform/storage/drift/drift-db.ts` — type import only (`WeeklyTrendPoint`); does not pull in runtime behavior.

This file must **not** depend on:
- `features/orchestration/` — Orchestration depends on Drift, not the reverse.
- `domains/flows/` — Drift has no dependency on flow types.
- `graph/` — Knowledge Graph is a separate bounded context.

## Consumer Pattern

Consumers that need drift capabilities depend on `IDriftStore` and receive a concrete `DriftStore` via dependency injection at the call site:

```typescript
// In features/orchestration/engine/effects.ts (planned pattern after ddd-03)
import type { IDriftStore } from "@domains/drift/drift-store.interface.ts";

export async function applyDriftEffect(store: IDriftStore, entry: ReviewEntry) {
  await store.appendReview(entry);
}
```

The concrete `DriftStore` (`platform/storage/drift/store.ts`) satisfies `IDriftStore` structurally — no explicit `implements` keyword is required because TypeScript uses structural typing. The Orchestration context never imports from `platform/storage/drift/` directly.

## Dependency Rules

```
Orchestration Context
       │
       │  depends on (interface only)
       ▼
domains/drift/IDriftStore   ◄── this directory
       │
       │  satisfied by (structural typing)
       ▼
platform/storage/drift/DriftStore  →  DriftDb (SQLite)
```

These rules are enforced by `dependency-cruiser`. Run `npm run lint:deps` to verify.
