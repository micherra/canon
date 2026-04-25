# shared/ — Shared Kernel

<!-- Managed by Canon. Manual edits are preserved. -->

## Purpose
Shared kernel — cross-cutting utilities, constants, parsers, and low-level helpers used by all features. This is the dependency root of the codebase: every layer may import from `shared/`, but `shared/` must not import from any bounded context.

## Architecture
<!-- last-updated: 2026-04-23 -->

**Top-level modules:**

| File | Responsibility |
|------|---------------|
| `constants.ts` | Canonical constants: `CANON_DIR`, `CANON_FILES` (now includes `JANITOR_LOCK`), `LAYER_CENTRALITY`, file extension sets, embedding config, `JOB_TIMEOUT_MS`, `PRINCIPLE_SECTIONS` |
| `schema.ts` | Shared Zod schemas: `reportInputSchema`, `ReportInput`, `ReviewEntry`, `ReviewViolation` — cross-boundary types used by pr-review, diagnostics, and orchestration |
| `matcher.ts` | Principle matching engine: `matchPrinciples`, `inferLayer`, `loadPrinciplesFromDir`, `loadAllPrinciples` |
| `parser.ts` | Principle file parser: `Principle`, `parsePrinciple`, `loadPrincipleFile`, `parseFrontmatter`, `extractSections`, `filterBodyBySections` |

**`lib/`** — Focused utility modules with no cross-context knowledge:
<!-- last-updated: 2026-04-23 -->

| File | Key exports |
|------|-------------|
| `tool-result.ts` | `ToolResult<T>`, `CanonToolError`, `CanonErrorCode`, `toolOk`, `toolError`, `isToolError`, `assertOk` |
| `wrap-handler.ts` | `wrapHandler` — wraps MCP tool handlers, converts unexpected throws to `UNEXPECTED` errors |
| `config.ts` | `buildLayerInferrer`, `loadLayerMappings`, `loadLayerMappingsStrict`, `loadGraphCompositionConfig`, `loadConfigNumber`, `loadJanitorConfig`, `JanitorConfig` — janitor config from `.canon/config.json` `janitor` key; added 2026-04-23 |
| `atomic-write.ts` | `atomicWriteFile` — write-then-rename for concurrent-safe file writes |
| `id.ts` | `generateId` — prefixed, date-stamped ID generation |
| `env.ts` | `isSyncMode`, `isCI` — environment detection predicates |
| `errors.ts` | `isNotFound` — type guard for `ENOENT` filesystem errors |
| `git-ref.ts` | `sanitizeGitRef` — validates and sanitizes git ref strings |
| `worktree-guard.ts` | `isPathContained`, `isPathInWorktree` — path traversal prevention |
| `paths.ts` | `toPosix`, `loadPathAliases` — path normalization and tsconfig alias loading |
| `fuzzy-field-validation.ts` | `suggestField`, `checkUnknownFields`, `installFuzzyValidation` — Levenshtein-based field name suggestions |
| `learn-lock.ts` | Auto-learn lock file management |
| `janitor-lock.ts` | `acquireJanitorLock`, `commitJanitorLock`, `releaseJanitorLock`, `getLastJanitorTimestamp` — `.canon/janitor.lock` PID+mtime lock for janitor concurrency control; added 2026-04-23 |
| `commit-trailers.ts` | `TrailerOpts`, `formatCommitTrailers`, `buildCommitMessage` — formats Canon-Workflow/Agent/State/Task git trailer blocks; added 2026-04-09 |
| `file-claims.ts` | `readClaims`, `writeClaims`, `registerClaims`, `releaseClaims`, `checkClaimOverlaps` — `.canon/claims.json` concurrent workflow conflict detection; added 2026-04-09 |

## Invariants
<!-- last-updated: 2026-04-09 -->
- `shared/` must not import from `features/`, `domains/`, or `platform/` — it is a leaf dependency
- All exports are pure functions or types; no module-level side effects
- `ReviewEntry` belongs here because it crosses the pr-review/diagnostics/orchestration boundary; single-context types belong in their feature
- `lib/paths.ts` currently imports `@graph/import-parser.ts` — this is a known boundary violation to be resolved

## Conventions
<!-- last-updated: 2026-04-09 -->
- `lib/` files are single-concern — one concept per file, no cross-lib imports
- All tool functions across features use `ToolResult<T>` from `lib/tool-result.ts`
- All tool handler registrations use `wrapHandler` from `lib/wrap-handler.ts`
- If a type is used by only one context, it belongs in that context — resist the gravity well
