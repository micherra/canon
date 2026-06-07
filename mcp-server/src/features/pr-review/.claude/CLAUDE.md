# pr-review/ — PR Review Tools

<!-- Managed by Canon. Manual edits are preserved. -->

## Purpose
PR review tools: unified PR impact analysis, code review surfacing, review persistence, and pre-rendered review artifact presentation.

## Architecture
<!-- last-updated: 2026-06-06 -->

**`tools/`** — MCP tool handlers.

| Tool file | MCP tool name | Notes |
|-----------|--------------|-------|
| `show-pr-impact.ts` | `show_pr_impact` | Unified PR analysis; returns `UnifiedPrOutput` with `has_review` boolean; `status` always `"ok"`; resource URI: `ui://canon/pr-review`; optional `worktree_path` scopes diff cwd (KG/DriftStore remain on projectDir; invalid path returns `error` field, never throws) |
| `review-code.ts` | `review_code` | Surface principles for code review + code content |
| `store-pr-review.ts` | `store_pr_review` | Persist PR review result; accepts optional `craft_profile` |
| `present-review.ts` | `present_review` | `showPrImpact` → read pre-rendered `review.html` → `presentArtifact`; returns `{ url: string }`; `INVALID_INPUT` when `review.html` missing or `has_review === false` |
| `pr-review-data.ts` | (service, not tool) | `getPrReviewData` — top-level assembler; returns `{ error }` for invalid `pr_number` (never throws) |
| `pr-review-data-helpers.ts` | (service, not tool) | Pure helper functions; see Contracts below |

## Contracts
<!-- last-updated: 2026-06-05 -->

**PR Review Data helpers** (`tools/pr-review-data-helpers.ts`) — pure functions: `classifyFile`, `generateNarrative`, `buildFileViolationMap`, `assembleOutput`. Bucket thresholds: `needs-attention` = violations OR high in_degree; `worth-a-look` = priority ≥ 5. Extracted 2026-05-25.

**`getPrReviewData`** (`tools/pr-review-data.ts`) — top-level assembler; returns `{ error }` (not throw) for invalid `pr_number`.

**`store_pr_review`** — accepts optional `craft_profile` (validated via `CraftProfileSchema`); persists one row per distinct subsystem area to `craft_profiles` table with `source:"review"`.

## Invariants
<!-- last-updated: 2026-06-05 -->
- Must not import directly from other features — use `@domains/*` types as shared contracts
- `getPrReviewData` returns `{ error }` for invalid input — never throws
