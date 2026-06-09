# diagnostics/ — Diagnostic Tools

<!-- Managed by Canon. Manual edits are preserved. -->

## Purpose
Diagnostic tools for Canon's meta-layer: drift reports, doc freshness, wiki lint, agent metrics, signal compilation, and summary storage. All tools surface quality signals; none mutate workflow state.

## Architecture
<!-- last-updated: 2026-06-02 -->

**`tools/`** — MCP tool handlers (thin wrappers calling services).

| Tool file | MCP tool name | Notes |
|-----------|--------------|-------|
| `wiki-lint.ts` | `wiki_lint` | Lints Canon's own meta-layer artifacts; see Contracts below |
| `get-drift-report.ts` | `get_drift_report` | Full drift report — compliance rates, hotspots, trend, doc freshness |
| `record-agent-metrics.ts` | `record_agent_metrics` | Agent-callable metrics recorder |
| `store-summaries.ts` | `store_summaries` | DB-only summary persistence |

**`services/`** — Pure functions; all accept pre-loaded data (no I/O except `scanDirectories`).

| File | Responsibility |
|------|---------------|
| `wiki-lint.ts` | `checkContradictions`, `checkOrphanPrinciples`, `checkStaleRefs`, `checkMissingExamples`, `checkCitedPaths`, `checkScopeLayers`, `checkScopeTags`, `assembleWikiLintOutput(AssembleWikiLintInput)` |
| `doc-gap-detect.ts` | `detectDocGaps(entries)`, `scanDirectories(rootDir, excludeDirs?)` |
| `signal-compiler.ts` | `compileSignals(filePaths, driftDbSignals)` — read-only; scores by priority within per-file token budget |
| `pitfall-enrichment.ts` | `queryDriftSignalPitfalls`, `queryErrorFixPitfalls`, `formatPitfallsSection`, `countPitfalls` |
| `area-memory-enrichment.ts` | `queryAreaObservations`, `formatAreaMemorySection`, `buildAreaMemorySection`; fail-open |
| `hot-file-detection.ts` | `detectHotFiles`, `formatHotFileSection`, `buildHotFileSection`; threshold ≥ 3 appearances |
| `doc-freshness.ts` | `computeDocFreshness` — enumerates `docs/*.md` (excludes `docs/reference/`); ENOENT → `[]` |
| `backfill-error-fixes.ts` | One-off script; mines `file_violation_history` to seed `error_fixes` table |
| `craft-audit-service.ts` | Pure audit area selector + profile persistence; see Contracts below |

## Contracts
<!-- last-updated: 2026-06-08 (ddd-doc-freshness: stale_refs + cited_paths now scan DDD doc set; filesScanned includes dddDocFiles) -->

**Craft audit service** (`services/craft-audit-service.ts`) — `selectAuditAreas(files, options?)` pure selector; bounded by `limit` default 5; `persistAuditProfile(areas, ratings, dao)` writes `source:"audit"` rows via injected `CraftProfileDao`; reuses `CraftProfileSchema` + `deriveSubsystemKey`. Added 2026-06-03.

**`wiki_lint` tool** — `wikiLint(input, projectDir)` runs any combination of 7 checks; returns `WikiLintOutput` with per-check arrays + `total_findings`.

`CheckName` union (all valid values for the optional `checks` input array):

| Value | What it checks |
|-------|---------------|
| `"contradictions"` | Conflicting rules between CLAUDE.md files |
| `"orphan_principles"` | Principles not referenced anywhere |
| `"stale_refs"` | File refs in CLAUDE.md files, plan docs, **and DDD doc set** that no longer resolve |
| `"missing_examples"` | Principles lacking usage examples |
| `"cited_paths"` | File paths cited in `references/**/*.md` **and DDD doc set** that do not resolve from repo root |
| `"scope_layers"` | `scope.layers` values in principles outside the valid set (derived from `loadLayerMappings(projectDir)` — project config keys when `.canon/config.json` defines `layers`, otherwise defaults; replaces defaults entirely when config defines any layers) |
| `"scope_tags"` | `scope.tags` values in principles outside `VALID_COMPUTED_TAGS` (static const from `kg-tags.ts` — 15 values, no I/O); both `scope_tags` and `scope_layers` emit a "must be a YAML list" finding when the field is a scalar string |

**DDD doc set** (scanned by `stale_refs` and `cited_paths`): `docs/**/*.md` excluding `docs/explore/`, plus `mcp-server/src/domains/*/README.md`, plus root `CONTEXT.md`. Collected by `collectDddDocPaths(projectDir)` via live filesystem scan (KG-independent). `docs/explore/` excluded — stale-by-design competition/direction records produce false findings.

**`cited_paths` check** (added 2026-06-02; extended to DDD doc set 2026-06-08): scans every `references/**/*.md` file and every DDD doc. A candidate is only considered when it is a backtick-quoted token matching the pattern `` `<alpha><word-chars/dots/slashes/hyphens>.<ext>` `` where `<ext>` is one of `sh|ts|js|md|json|yaml|yml`. It is excluded (not flagged) when: it contains `${`, `<`, `>`, `{`, or `}` (template variables / placeholders); starts with `http://` or `https://`; starts with `#`; has no `/` (bare filename); or appears inside a fenced block whose opening line is labeled `example`, `hypothetical`, or `template`. A non-excluded candidate that does not resolve from the repo root is reported as a finding with its 1-based line number. Conservative by design — false positives are worse than misses.

**`assembleWikiLintOutput(input: AssembleWikiLintInput)`** — `total_findings` includes all 7 check counts including `scopeLayers` and `scopeTags`. `filesScanned` counts CLAUDE.md files + agent files + DDD doc files.

## Invariants
<!-- last-updated: 2026-06-08 -->
- All service functions are pure: no I/O except `scanDirectories` and `doc-freshness.ts` (git + fs reads)
- `tools/wiki-lint.ts` is the only file that calls `existsSync` for `checkCitedPaths`; service layer receives an injected `existsOnDisk` predicate (pure-IO split)
- `checkCitedPaths` scans `references/**/*.md` and DDD doc set; `collectDddDocPaths` performs a live filesystem scan (never depends on KG graph store)
- `dddDocFiles` is only loaded when `stale_refs` or `cited_paths` is enabled — no unnecessary filesystem scans for unrelated check subsets
- `checkScopeLayers` is a pure function in `services/wiki-lint.ts`; `tools/wiki-lint.ts` calls `loadLayerMappings(projectDir)` at the I/O boundary and passes `Object.keys(mappings)` as `validLayers` — no I/O in the service
- `checkScopeTags` is a pure function in `services/wiki-lint.ts`; vocabulary (`VALID_COMPUTED_TAGS`) is injected at the tool boundary from `kg-tags.ts` — no I/O in the service; mirrors `checkScopeLayers` in structure

## Conventions
<!-- last-updated: 2026-06-03 -->
- Pure check functions export their helpers (`isExcludedCitedPath`) for direct testing; fence-skip logic is inline in `collectCitedPathsInFile` (not exported) since 2026-06-02
- Recursive scanners thread `originalRoot` through all recursive calls (root-drift bug class prevention)
