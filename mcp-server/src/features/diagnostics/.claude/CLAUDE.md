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
| `wiki-lint.ts` | `checkContradictions`, `checkOrphanPrinciples`, `checkStaleRefs`, `checkMissingExamples`, `checkCitedPaths`, `assembleWikiLintOutput(AssembleWikiLintInput)` |
| `doc-gap-detect.ts` | `detectDocGaps(entries)`, `scanDirectories(rootDir, excludeDirs?)` |
| `signal-compiler.ts` | `compileSignals(filePaths, driftDbSignals)` — read-only; scores by priority within per-file token budget |
| `pitfall-enrichment.ts` | `queryDriftSignalPitfalls`, `queryErrorFixPitfalls`, `formatPitfallsSection`, `countPitfalls` |
| `area-memory-enrichment.ts` | `queryAreaObservations`, `formatAreaMemorySection`, `buildAreaMemorySection`; fail-open |
| `hot-file-detection.ts` | `detectHotFiles`, `formatHotFileSection`, `buildHotFileSection`; threshold ≥ 3 appearances |
| `doc-freshness.ts` | `computeDocFreshness` — enumerates `docs/*.md` (excludes `docs/reference/`); ENOENT → `[]` |
| `backfill-error-fixes.ts` | One-off script; mines `file_violation_history` to seed `error_fixes` table |

## Contracts
<!-- last-updated: 2026-06-02 -->

**`wiki_lint` tool** — `wikiLint(input, projectDir)` runs any combination of 5 checks; returns `WikiLintOutput` with per-check arrays + `total_findings`.

`CheckName` union (all valid values for the optional `checks` input array):

| Value | What it checks |
|-------|---------------|
| `"contradictions"` | Conflicting rules between CLAUDE.md files |
| `"orphan_principles"` | Principles not referenced anywhere |
| `"stale_refs"` | File refs in principles that no longer resolve |
| `"missing_examples"` | Principles lacking usage examples |
| `"cited_paths"` | File paths cited in `references/**/*.md` that do not resolve from repo root |

**`cited_paths` check** (added 2026-06-02): scans every `references/**/*.md` file. A path string is a finding when it contains a `/` (bare filenames exempt), does not start with `http`/`#`, is not a template variable (`${...}`, `<...>`, `{...}`), and is not inside a fenced block labeled `example`, `hypothetical`, or `template`. Correct 1-based line numbers reported. Conservative by design — false positives are worse than misses.

**`assembleWikiLintOutput(input: AssembleWikiLintInput)`** — `total_findings` includes the `cited_paths` count.

## Invariants
<!-- last-updated: 2026-06-02 -->
- All service functions are pure: no I/O except `scanDirectories` and `doc-freshness.ts` (git + fs reads)
- `tools/wiki-lint.ts` is the only file that calls `existsSync` for `checkCitedPaths`; service layer receives an injected `existsOnDisk` predicate (pure-IO split)
- `checkCitedPaths` scans `references/**/*.md` only; does not scan other directories

## Conventions
<!-- last-updated: 2026-06-02 -->
- Pure check functions export their helpers (`isExcludedCitedPath`, `stripIllustrativeFences`) for direct testing
- Recursive scanners thread `originalRoot` through all recursive calls (root-drift bug class prevention)
