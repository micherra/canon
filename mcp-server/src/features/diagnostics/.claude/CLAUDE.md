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
| `wiki-lint.ts` | `checkContradictions`, `checkOrphanPrinciples`, `checkStaleRefs`, `checkMissingExamples`, `checkCitedPaths`, `checkScopeLayers`, `assembleWikiLintOutput(AssembleWikiLintInput)` |
| `doc-gap-detect.ts` | `detectDocGaps(entries)`, `scanDirectories(rootDir, excludeDirs?)` |
| `signal-compiler.ts` | `compileSignals(filePaths, driftDbSignals)` — read-only; scores by priority within per-file token budget |
| `pitfall-enrichment.ts` | `queryDriftSignalPitfalls`, `queryErrorFixPitfalls`, `formatPitfallsSection`, `countPitfalls` |
| `area-memory-enrichment.ts` | `queryAreaObservations`, `formatAreaMemorySection`, `buildAreaMemorySection`; fail-open |
| `hot-file-detection.ts` | `detectHotFiles`, `formatHotFileSection`, `buildHotFileSection`; threshold ≥ 3 appearances |
| `doc-freshness.ts` | `computeDocFreshness` — enumerates `docs/*.md` (excludes `docs/reference/`); ENOENT → `[]` |
| `backfill-error-fixes.ts` | One-off script; mines `file_violation_history` to seed `error_fixes` table |

## Contracts
<!-- last-updated: 2026-06-05 (scope_layers: 6th CheckName; checkScopeLayers in services/wiki-lint.ts) -->

**`wiki_lint` tool** — `wikiLint(input, projectDir)` runs any combination of 6 checks; returns `WikiLintOutput` with per-check arrays + `total_findings`.

`CheckName` union (all valid values for the optional `checks` input array):

| Value | What it checks |
|-------|---------------|
| `"contradictions"` | Conflicting rules between CLAUDE.md files |
| `"orphan_principles"` | Principles not referenced anywhere |
| `"stale_refs"` | File refs in principles that no longer resolve |
| `"missing_examples"` | Principles lacking usage examples |
| `"cited_paths"` | File paths cited in `references/**/*.md` that do not resolve from repo root |
| `"scope_layers"` | `scope.layers` values in principles outside the valid set (`VALID_LAYERS` derived from `DEFAULT_LAYER_MAPPINGS`) |

**`cited_paths` check** (added 2026-06-02): scans every `references/**/*.md` file. A candidate is only considered when it is a backtick-quoted token matching the pattern `` `<alpha><word-chars/dots/slashes/hyphens>.<ext>` `` where `<ext>` is one of `sh|ts|js|md|json|yaml|yml`. It is excluded (not flagged) when: it contains `${`, `<`, `>`, `{`, or `}` (template variables / placeholders); starts with `http://` or `https://`; starts with `#`; has no `/` (bare filename); or appears inside a fenced block whose opening line is labeled `example`, `hypothetical`, or `template`. A non-excluded candidate that does not resolve from the repo root is reported as a finding with its 1-based line number. Conservative by design — false positives are worse than misses.

**`assembleWikiLintOutput(input: AssembleWikiLintInput)`** — `total_findings` includes all 6 check counts including `scopeLayers`.

## Invariants
<!-- last-updated: 2026-06-02 -->
- All service functions are pure: no I/O except `scanDirectories` and `doc-freshness.ts` (git + fs reads)
- `tools/wiki-lint.ts` is the only file that calls `existsSync` for `checkCitedPaths`; service layer receives an injected `existsOnDisk` predicate (pure-IO split)
- `checkCitedPaths` scans `references/**/*.md` only; does not scan other directories
- `checkScopeLayers` is a pure function in `services/wiki-lint.ts`; `tools/wiki-lint.ts` supplies the `principles` array and `VALID_LAYERS` (no I/O in the service)

## Conventions
<!-- last-updated: 2026-06-03 -->
- Pure check functions export their helpers (`isExcludedCitedPath`) for direct testing; fence-skip logic is inline in `collectCitedPathsInFile` (not exported) since 2026-06-02
- Recursive scanners thread `originalRoot` through all recursive calls (root-drift bug class prevention)
