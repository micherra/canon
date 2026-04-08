# shared/ — Shared Kernel

This directory is the **Shared Kernel** of the Canon MCP server. It contains cross-cutting types, constants, utilities, and low-level helpers that all bounded contexts depend on. It is the dependency root of the codebase: every other layer may import from `shared/`, but `shared/` must not import from any bounded context.

## What this context owns

### `constants.ts`

Single source of truth for values used across all contexts:

- `CANON_DIR` — the `.canon` data directory name
- `CANON_FILES` — record of canonical file names (`CONFIG`, `DRIFT_DB`, `KNOWLEDGE_DB`, `ORCHESTRATION_DB`)
- `LAYER_CENTRALITY` — architecture layer weights used for impact scoring
- `JS_EXTENSIONS`, `PY_EXTENSIONS`, `SCANNABLE_EXTENSIONS`, `RESOLVE_EXTENSIONS` — file extension sets for scanning and import resolution
- `FILE_PREVIEW_MAX_LINES` — maximum lines returned by `get_file_context`
- `EMBEDDING_MODEL`, `EMBEDDING_DIM`, `EMBEDDING_BATCH_SIZE`, `EMBEDDING_MODEL_ID` — embedding configuration
- `JOB_TIMEOUT_MS` — default background job timeout
- `PRINCIPLE_SECTIONS` — known section heading labels for principle markdown parsing
- `extractSummary(body)` — extracts the first paragraph from a principle body

### `schema.ts`

Shared Zod schemas and TypeScript types for review data persisted across contexts:

- `reportInputSchema` — Zod schema for the `report` tool's input; validates review type, files, scores, violations, and verdict
- `ReportInput` — inferred type from `reportInputSchema`
- `ReviewEntry` — storage type for a completed review; extends the review input with `review_id`, `timestamp`, required `verdict`, and optional PR fields (`pr_number`, `branch`, `last_reviewed_sha`, `file_priorities`, `recommendations`)
- `ReviewViolation` — type for a single violation entry within a `ReviewEntry`

`ReviewEntry` is the shared record type that crosses the boundary between the `pr-review` feature, the `diagnostics` feature, and the `orchestration` domain. It belongs here because it is genuinely used by multiple contexts.

### `matcher.ts`

Principle matching engine — used by the `principles` feature to filter principles by context:

- `MatchFilters` — type for filter criteria: `layers`, `file_path`, `severity_filter`, `tags`, `include_archived`
- `matchPrinciples(principles, filters)` — filter and sort an array of `Principle` objects by the given criteria; sorts by severity rank and specificity
- `inferLayer(filePath)` — infer the architecture layer of a file path using the default layer mappings
- `loadPrinciplesFromDir(dir)` — load all principle markdown files from a directory tree
- `loadAllPrinciples(projectDir, pluginDir)` — load and merge principles from both the project's `.canon/principles/` and the plugin's `principles/` directories; project-local principles override plugin principles on ID conflict; results are cached and invalidated by file mtime

### `parser.ts`

Principle file parser — parses YAML frontmatter and structured sections from principle markdown files:

- `Principle` — core domain type representing a loaded principle with `id`, `title`, `severity`, `scope`, `tags`, `archived`, `body`, `filePath`, and optional `anti_rationalization` / `verification` sections
- `PrincipleScope` — `{ layers: string[]; file_patterns: string[] }`
- `parsePrinciple(content, filePath)` — parse a principle markdown string into a `Principle` object
- `loadPrincipleFile(filePath)` — read and parse a principle markdown file from disk
- `parseFrontmatter(content)` — extract YAML frontmatter and body from any markdown string
- `extractSections(body)` — split a principle body into known sections (Anti-Rationalization, Verification) and remainder
- `filterBodyBySections(body, anti_rationalization, verification, sections)` — return full body or a filtered subset based on requested section keys

### `lib/`

Low-level utility modules. Each file is a focused helper with no cross-context knowledge:

| File | Exports | Purpose |
|------|---------|---------|
| `tool-result.ts` | `ToolResult<T>`, `CanonToolError`, `CanonErrorCode`, `toolOk`, `toolError`, `isToolError`, `assertOk`, `ProcessResult` | Discriminated union error handling pattern for all tool functions. Tools return `ToolResult<T>` instead of throwing for expected errors. |
| `wrap-handler.ts` | `wrapHandler` | MCP tool handler wrapper; catches unexpected throws and converts them to typed `UNEXPECTED` `CanonToolError` responses. All tool registrations use this wrapper. |
| `config.ts` | `DEFAULT_LAYER_MAPPINGS`, `LayerMappings`, `buildLayerInferrer`, `loadLayerMappings`, `loadLayerMappingsStrict`, `deriveSourceDirsFromLayers`, `loadGraphCompositionConfig`, `loadConfigNumber` | Load and apply layer mappings and other configuration from `.canon/config.json`. `buildLayerInferrer` supports both glob patterns and plain directory name segments. |
| `atomic-write.ts` | `atomicWriteFile` | Write-then-rename atomic file writes; prevents partial reads on concurrent access. |
| `id.ts` | `generateId` | Generate a prefixed, date-stamped ID with a random hex suffix (e.g., `rev_20260407_abc123`). |
| `env.ts` | `isSyncMode`, `isCI` | Pure boolean predicates for environment detection; used to switch between async and synchronous job execution. |
| `errors.ts` | `isNotFound` | Type guard for Node.js `ENOENT` filesystem errors. |
| `git-ref.ts` | `sanitizeGitRef` | Validate and sanitize git ref strings; rejects unsafe characters, leading dashes, and `..` sequences. |
| `worktree-guard.ts` | `isPathContained`, `isPathInWorktree` | Path containment checks with symlink resolution; prevents path traversal attacks in file operations. |
| `paths.ts` | `toPosix`, `loadPathAliases` | Normalize file paths to POSIX format; load TypeScript path aliases from `tsconfig.json`. |
| `fuzzy-field-validation.ts` | `suggestField`, `checkUnknownFields`, `installFuzzyValidation` | Levenshtein-based fuzzy field name suggestions for MCP tool input validation errors. |

## What this context does NOT own

**`shared/` is not a general dumping ground.** The gravity well failure mode for a shared kernel is accumulating types and logic that belong elsewhere. Apply this rule strictly:

- **If a type is used by only one context, it belongs in that context.** Move it there.
- **Domain logic does not belong here.** Flow execution, orchestration state machines, drift analytics, graph traversal, and PR review logic all belong in their respective features.
- **Context-specific schemas do not belong here.** `ReviewEntry` belongs here because it crosses the pr-review/diagnostics/orchestration boundary. A schema used only by the `orchestration` feature belongs in `features/orchestration/`.
- **Framework glue does not belong here.** MCP SDK integration code, database connection setup, and HTTP client configuration belong in `platform/` or in the feature that owns them.

Examples of types that do NOT belong in `shared/`:
- `FlowDefinition`, `BoardState`, `ExecutionStore` — owned by `features/orchestration/`
- `KgQuery`, `FileMetrics`, `LayerViolation` — owned by `features/knowledge-graph/`
- `DriftStore`, `FlowRunEntry` — owned by `features/diagnostics/`
- `PrReviewDataOutput`, `BlastRadiusEntry` — owned by `features/pr-review/`

## Public interface

The most important exports for cross-context consumers:

```typescript
// Error handling — all tool functions return ToolResult<T>
import { ToolResult, CanonToolError, toolOk, toolError, isToolError, assertOk } from "@shared/lib/tool-result.ts";

// File system constants — canonical paths
import { CANON_DIR, CANON_FILES } from "@shared/constants.ts";

// Shared storage type used by pr-review and diagnostics
import { ReviewEntry, ReviewViolation } from "@shared/schema.ts";

// Principle loading and matching
import { Principle, loadAllPrinciples } from "@shared/matcher.ts";
import { parsePrinciple, loadPrincipleFile } from "@shared/parser.ts";

// Config utilities
import { buildLayerInferrer, loadLayerMappings } from "@shared/lib/config.ts";

// Safety utilities
import { atomicWriteFile } from "@shared/lib/atomic-write.ts";
import { isPathInWorktree } from "@shared/lib/worktree-guard.ts";
import { sanitizeGitRef } from "@shared/lib/git-ref.ts";
import { generateId } from "@shared/lib/id.ts";
import { wrapHandler } from "@shared/lib/wrap-handler.ts";
```

## Allowed dependencies

`shared/` has a strict dependency rule: **it may only import from external packages, never from other bounded contexts.**

| Allowed | Disallowed |
|---------|-----------|
| `zod` (schema validation) | `domains/` (any module) |
| `gray-matter` (frontmatter parsing) | `features/` (any feature) |
| `node:fs/promises`, `node:path`, `node:crypto` (Node built-ins) | `platform/` (job manager, infrastructure) |
| `@modelcontextprotocol/sdk` (for `wrap-handler.ts` and `fuzzy-field-validation.ts`) | Any relative import going up and then into another context |

If you find `shared/` importing from `domains/`, `features/`, or `platform/`, that is a **boundary violation**. The import direction must always point inward — toward the shared kernel, never outward from it.

> Note: `lib/paths.ts` currently imports `@graph/import-parser.ts` via a TypeScript path alias. This is a boundary violation that should be resolved by moving the `PathAlias` type and `parseTsconfigPaths` function into `shared/` or by extracting a shared type that `paths.ts` can depend on without reaching into the knowledge-graph feature.
