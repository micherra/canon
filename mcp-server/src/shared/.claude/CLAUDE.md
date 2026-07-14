# shared/ — Shared Kernel

<!-- Managed by Canon. Manual edits are preserved. -->

## Purpose
Shared kernel — cross-cutting utilities, constants, parsers, and low-level helpers used by all features. This is the dependency root of the codebase: every layer may import from `shared/`, but `shared/` must not import from any bounded context.

## Architecture
<!-- last-updated: 2026-06-12 -->

**Top-level modules:**

| File | Responsibility |
|------|---------------|
| `constants.ts` | Canonical constants: `CANON_DIR`, `CANON_FILES` (now includes `JANITOR_LOCK`), `LAYER_CENTRALITY`, file extension sets, embedding config, `JOB_TIMEOUT_MS`, `PRINCIPLE_SECTIONS`, `GRAPH_HEAD_COMMIT_KEY` (KG freshness marker key) |
| `schema.ts` | Shared Zod schemas: `reportInputSchema`, `ReportInput`, `ReviewEntry` (includes optional `craft_profile?: CraftProfile`), `ReviewViolation`, `CraftProfile`, `CraftProfileSchema`, `CraftDimensionRating` — cross-boundary types used by pr-review, diagnostics, and orchestration |
| `matcher.ts` | Principle matching engine: `matchPrinciples`, `inferLayer`, `loadPrinciplesFromDir`, `loadAllPrinciples`; file-pattern matching uses `matchGlob` from `lib/glob-matcher.ts` — `globToRegex`+RegExp removed (ADR-0026 §Amendment-3) |
| `parser.ts` | Principle file parser: `Principle` (includes `portable?: boolean` field added 2026-06-12), `parsePrinciple`, `parsePortable`, `loadPrincipleFile`, `parseFrontmatter`, `extractSections`, `filterBodyBySections`; `parseFrontmatter` now delegates to `splitFrontmatter` from `lib/frontmatter.ts` (was `gray-matter`; R0) |

**`lib/`** — Focused utility modules with no cross-context knowledge:
<!-- last-updated: 2026-07-14 -->

| File | Key exports |
|------|-------------|
| `frontmatter.ts` | `splitFrontmatter(content)` → `{ data, body }` pure seam (replaces `gray-matter` across all call sites); `readFrontmatter(filePath)` I/O boundary wrapper; backed by `yaml` lib — preserves exact `gray-matter` `{ data, body }` contract including throw-on-malformed-YAML, empty/comment-only block → `{}`, block scalars, inline arrays, nested maps; added 2026-06-24 (R0) |
| `craft-rubric.ts` | `CRAFT_DIMENSIONS` (6 strings), `CRAFT_BANDS`, `CRAFT_DIMENSION_PRINCIPLES`, `craftBandOrdinal(band)`, `craftRollup(ratings)` — craft scoring primitives; added 2026-06-03 |
| `tool-result.ts` | `ToolResult<T>`, `CanonToolError`, `CanonErrorCode`, `toolOk`, `toolError`, `isToolError`, `assertOk` |
| `wrap-handler.ts` | `wrapHandler` — wraps MCP tool handlers, converts unexpected throws to `UNEXPECTED` errors |
| `config.ts` | `buildLayerInferrer`, `loadLayerMappings`, `loadLayerMappingsStrict`, `loadGraphCompositionConfig`, `loadConfigNumber`, `loadJanitorConfig`, `JanitorConfig`, `VALID_LAYERS` — janitor config from `.canon/config.json` `janitor` key; `VALID_LAYERS` = `Object.keys(DEFAULT_LAYER_MAPPINGS)` (derived valid set for `scope.layers`); added 2026-04-23, `VALID_LAYERS` added 2026-06-05 |
| `atomic-write.ts` | `atomicWriteFile` — write-then-rename for concurrent-safe single-file writes; `atomicWritePair(path1, data1, path2, data2)` — writes both temp files first then renames both, so callers see either both old files or both new files (prevents the md-new/meta-old divergence window); used by `write_review` for REVIEW.md + REVIEW.meta.json pairs. Added `atomicWritePair` 2026-06-24. |
| `id.ts` | `generateId` — prefixed, date-stamped ID generation |
| `env.ts` | `isSyncMode`, `isCI` — environment detection predicates |
| `errors.ts` | `isNotFound` — type guard for `ENOENT` filesystem errors |
| `git-ref.ts` | `sanitizeGitRef` — validates and sanitizes git ref strings |
| `worktree-guard.ts` | `isPathContained`, `isPathInWorktree` — path traversal prevention |
| `paths.ts` | `toPosix`, `loadPathAliases` — path normalization and tsconfig alias loading |
| `fuzzy-field-validation.ts` | `suggestField`, `checkUnknownFields`, `installFuzzyValidation` — Levenshtein-based field name suggestions |
| `overlay-untrusted-text.ts` | Opaque-box `UntrustedText` type (NOT a `string` subtype — opaque object, TS2322 on raw assignment to `string`); `brandUntrusted(v)` stamps at load boundary; `renderUntrusted(v, {source})` / `renderUntrustedProjection(...)` fence for `source==="project"`, pass through for plugin/undefined; `rawUntrustedForStructuralUse(v)` audited non-model-facing escape hatch; `mapUntrusted(v, fn)` brand-preserving transform. Added 2026-06-27 (ADR-0026) |
| `overlay-closed-domain.ts` | Shared charset constants and filter functions for closed-domain Principle/Routine fields: `LAYER_CHARSET`, `FILE_PATTERN_CHARSET`, `TAG_CHARSET`; `filterLayers(arr)`, `filterFilePatterns(arr)`, `filterTagArray(arr)` — drop non-matching entries fail-closed (same posture as parser). Both writers (`parser.ts`, `matcher.ts`) import from this module. Added 2026-06-27 (ADR-0026 §Amendment-2) |
| `glob-matcher.ts` | Linear-time O(m·n) DP wildcard matcher for Canon's restricted glob dialect (`*` = non-slash wildcard, `**` = full wildcard); `matchGlob(pattern, path): boolean`; no `new RegExp` at match time — eliminates throw-DoS and all ReDoS classes; `FILE_PATTERN_MAX_LEN` cap bounds the DP table. Replaces `globToRegex`+RegExp in `matcher.ts`. Added 2026-06-27 (ADR-0026 §Amendment-3) |
| `safe-project-dir.ts` | `isSafeProjectDirInput(dir: string): boolean` — allow-list validation barrier for untrusted project-dir strings before any fs access; rejects empty, >4096 chars, NUL/control chars, relative paths, and raw `..` segments; no fixed safe root (projects may live at any absolute path). Applied in `session-manager.ts` `validateAndNormalizeDir`. Added 2026-06-30 (ADR-0030) |
| `learn-lock.ts` | Auto-learn lock file management |
| `janitor-lock.ts` | `acquireJanitorLock`, `commitJanitorLock`, `releaseJanitorLock`, `getLastJanitorTimestamp` — `.canon/janitor.lock` PID+mtime lock for janitor concurrency control; added 2026-04-23 |
| `commit-trailers.ts` | `TrailerOpts`, `formatCommitTrailers`, `buildCommitMessage` — formats Canon-Workflow/Agent/State/Task git trailer blocks; optional `evolutionId?` appends a `Canon-Evolution: {id}` line after Canon-Task (or after Canon-State when no task), additive/backward-compatible (ADR-0034); added 2026-04-09 |
| `file-claims.ts` | `readClaims`, `writeClaims`, `registerClaims`, `releaseClaims`, `checkClaimOverlaps` — `.canon/claims.json` concurrent workflow conflict detection; added 2026-04-09 |
| `waves-compiler.ts` | `compileWaves(input)` — pure single-wave DAG → `WavesEnvelope` compiler for canon-waves (SYNTHESIS Inc-5, Increment 1); fail-closed `{ ok: false, errors }` on invalid DAG, any `depends_on` (multi-wave out of scope), or missing prompt_seed — never a partial envelope; also exports `sanitizeTaskId`, `deriveTaskBranch`, `deriveTaskWorktreePath` (sole owners of the `canon-task/{sanitized}` branch/worktree-path convention, so the envelope and the worker prompt's embedded `BRANCH=` line can't drift apart). Consumed by `features/orchestration/tools/compile-waves.ts` (`compile_waves` MCP tool). Added 2026-07-14 (ADR-0053). |

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
