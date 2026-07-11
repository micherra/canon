# pr-review/ — PR Review Tools

<!-- Managed by Canon. Manual edits are preserved. -->

## Purpose
PR review tools: unified PR impact analysis, code review surfacing, and review persistence.

## Architecture
<!-- last-updated: 2026-07-10 -->

**`tools/`** — MCP tool handlers.

| Tool file | MCP tool name | Notes |
|-----------|--------------|-------|
| `show-pr-impact.ts` | `show_pr_impact` | Unified PR analysis; returns `UnifiedPrOutput` with `has_review` boolean; `status` always `"ok"`; resource URI: `ui://canon/pr-review`; optional `worktree_path` scopes diff cwd (KG/DriftStore remain on projectDir; invalid path returns `error` field, never throws); `findLatestReview`'s no-filter branch (no `branch`/`pr_number`) selects the stored review whose `files` exactly equal `prep.files` (`reviewMatchesPrepFiles`, path-set equality) — no global-latest fallback; no match → `has_review: false` (prep-only render). Explicit `branch`/`pr_number` filter path is unchanged (fixed 2026-07-10, was cross-PR contamination) |
| `review-code.ts` | `review_code` | Surface principles for code review + code content |
| `store-pr-review.ts` | `store_pr_review` | Persist PR review result; accepts optional `craft_profile` |
| `pr-review-data.ts` | (service, not tool) | `getPrReviewData` — top-level assembler; returns `{ error }` for invalid `pr_number` (never throws) |
| `pr-review-data-helpers.ts` | (service, not tool) | Pure helper functions; see Contracts below |

## Contracts
<!-- last-updated: 2026-06-12 -->

**PR Review Data helpers** (`tools/pr-review-data-helpers.ts`) — pure functions: `classifyFile`, `generateNarrative`, `buildFileViolationMap`, `assembleOutput`. Bucket thresholds: `needs-attention` = violations OR high in_degree; `worth-a-look` = priority ≥ 5. Extracted 2026-05-25.

**`getPrReviewData`** (`tools/pr-review-data.ts`) — top-level assembler; returns `{ error }` (not throw) for invalid `pr_number`.

**`store_pr_review`** — accepts optional `craft_profile`; delegates persistence to `validateAndPersistCraftProfile` imported from `@platform/storage/drift/craft-persistence.ts` (ADR-0003 — moved from this feature to break CRAFT-PERSIST cross-feature edge).

## Invariants
<!-- last-updated: 2026-07-10 -->
- Must not import directly from other features — use `@domains/*` types as shared contracts
- `getPrReviewData` returns `{ error }` for invalid input — never throws
- `show_pr_impact`'s top-level `review`/`blastRadius`/`subgraph` must describe the same change set as `prep` on every call — `findLatestReview`'s no-filter branch never falls back to the globally-latest stored review across all PRs; it selects only a review whose `files` exactly match `prep.files`
