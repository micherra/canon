# diagnostics/ — Diagnostic Tools

<!-- Managed by Canon. Manual edits are preserved. -->

## Purpose
Diagnostic tools for Canon's meta-layer: drift reports, doc freshness, wiki lint, agent metrics, signal compilation, and summary storage. All tools surface quality signals; none mutate workflow state.

## Architecture
<!-- last-updated: 2026-06-12 -->

**`tools/`** — MCP tool handlers (thin wrappers calling services).

| Tool file | MCP tool name | Notes |
|-----------|--------------|-------|
| `wiki-lint.ts` | `wiki_lint` | Lints Canon's own meta-layer artifacts; see Contracts below |
| `get-drift-report.ts` | `get_drift_report` | Full drift report — compliance rates, hotspots, trend, doc freshness |
| `record-agent-metrics.ts` | `record_agent_metrics` | Agent-callable metrics recorder |
| `store-summaries.ts` | `store_summaries` | DB-only summary persistence |
| `sync-indexes.ts` | `sync_indexes` | Regenerates sentinel-delimited `## Artifact Inventory` blocks in the 5 sibling artifact-class indexes; returns `{ synced[], skipped[] }` |

**`services/`** — Pure functions; all accept pre-loaded data (no I/O except `scanDirectories`).

| File | Responsibility |
|------|---------------|
| `wiki-lint.ts` | `checkContradictions`, `checkOrphanPrinciples`, `checkStaleRefs`, `checkMissingExamples`, `checkCitedPaths`, `checkScopeLayers`, `checkScopeTags`, `assembleWikiLintOutput(AssembleWikiLintInput)`; re-exports `GlossaryConsistencyFinding`, `MisroutedPrincipleFinding`, `DuplicateTitleFinding` types from siblings |
| `wiki-lint-glossary.ts` | `checkGlossaryConsistency(file)` — glossary wiki_lint check; parses CONTEXT.md H2 headings, detects exact-duplicate and naked-vs-qualified collisions; pure, no I/O |
| `wiki-lint-principle-tier.ts` | `checkMisroutedPrinciples(principles)`, `checkDuplicateTitles(principles)`, `normalizeTitle(title)` — principle-tier checks; `CANON_INTERNAL_PREFIXES` constant; split per `line-limit-split-into-siblings`; pure, no I/O |
| `index-inventory.ts` | `toDescriptors`, `renderInventoryBlock`, `rewriteManagedBlock`, `extractManagedBlock`, `diffIndex` (pure); `checkIndexDrift` (I/O boundary); sentinel constants `INVENTORY_START`/`INVENTORY_END`; types `ArtifactClass`, `ArtifactDescriptor`, `IndexDriftFinding`, `CLASS_DIRS` |
| `doc-gap-detect.ts` | `detectDocGaps(entries)`, `scanDirectories(rootDir, excludeDirs?)` |
| `signal-compiler.ts` | `compileSignals(filePaths, driftDbSignals)` — read-only; scores by priority within per-file token budget |
| `doc-freshness.ts` | `computeDocFreshness` — enumerates `docs/*.md` (excludes `docs/reference/`); ENOENT → `[]` |
| `backfill-error-fixes.ts` | One-off script; mines `file_violation_history` to seed `error_fixes` table |
| `craft-audit-service.ts` | Pure audit area selector + profile persistence; see Contracts below |

## Contracts
<!-- last-updated: 2026-06-12 -->

**Craft audit service** (`services/craft-audit-service.ts`) — `selectAuditAreas(files, options?)` pure selector; bounded by `limit` default 5; `persistAuditProfile(areas, ratings, dao)` writes `source:"audit"` rows via injected `CraftProfileDao`; reuses `CraftProfileSchema` + `deriveSubsystemKey`. Added 2026-06-03.

**`wiki_lint` tool** — `wikiLint(input, projectDir)` runs any combination of 10 non-`index_drift` checks (11 total with `index_drift`); returns `WikiLintOutput` with per-check arrays + `total_findings`. `WIKI_LINT_CHECK_NAMES` exported from `register-knowledge.ts` — derive-from-const parity with `CheckName` union (schema-parity test enforces this).

`CheckName` union (all valid values for the optional `checks` input array):

| Value | What it checks |
|-------|---------------|
| `"cited_paths"` | File paths cited in `references/**/*.md` **and DDD doc set** that do not resolve from repo root |
| `"contradictions"` | Conflicting rules between CLAUDE.md files |
| `"duplicate_titles"` | Two or more principles (across both tiers) sharing the same normalized title; normalization: lowercase, collapsed whitespace, stripped trailing punctuation |
| `"glossary_consistency"` | CONTEXT.md H2 headings — exact-duplicate or naked-vs-qualified collisions; allowed: same base with ≥2 distinct qualifiers |
| `"missing_examples"` | Principles lacking usage examples |
| `"misrouted_principles"` | Bidirectional tier mismatch: (A) principles in the shipped `principles/` tree with `portable: false` (explicit) OR with exclusively Canon-internal `scope.file_patterns` and no explicit `portable: true` override; (B) principles outside the shipped tier (e.g. `.canon/principles/`) with `portable: true` |
| `"orphan_principles"` | Principles not referenced anywhere |
| `"scope_layers"` | `scope.layers` values in principles outside the valid set (derived from `loadLayerMappings(projectDir)` — project config keys when `.canon/config.json` defines `layers`, otherwise defaults; replaces defaults entirely when config defines any layers) |
| `"scope_tags"` | `scope.tags` values in principles outside `VALID_COMPUTED_TAGS` (static const from `kg-tags.ts` — 15 values, no I/O); both `scope_tags` and `scope_layers` emit a "must be a YAML list" finding when the field is a scalar string |
| `"index_drift"` | Sentinel-delimited `## Artifact Inventory` blocks in the 5 sibling indexes diverge from on-disk artifact set; `MISSING_MARKERS` when block absent, `INVENTORY_MISMATCH` when content differs |
| `"stale_refs"` | File refs in CLAUDE.md files, plan docs, **and DDD doc set** that no longer resolve |

**DDD doc set** (scanned by `stale_refs` and `cited_paths`): `docs/**/*.md` excluding `docs/explore/`, plus `mcp-server/src/domains/*/README.md`, plus root `CONTEXT.md`. Collected by `collectDddDocPaths(projectDir)` via live filesystem scan (KG-independent). `docs/explore/` excluded — stale-by-design competition/direction records produce false findings.

**`cited_paths` check** (added 2026-06-02; extended to DDD doc set 2026-06-08): scans every `references/**/*.md` file and every DDD doc. A candidate is only considered when it is a backtick-quoted token matching the pattern `` `<alpha><word-chars/dots/slashes/hyphens>.<ext>` `` where `<ext>` is one of `sh|ts|js|md|json|yaml|yml`. It is excluded (not flagged) when: it contains `${`, `<`, `>`, `{`, or `}` (template variables / placeholders); starts with `http://` or `https://`; starts with `#`; has no `/` (bare filename); or appears inside a fenced block whose opening line is labeled `example`, `hypothetical`, or `template`. A non-excluded candidate that does not resolve from the repo root is reported as a finding with its 1-based line number. Conservative by design — false positives are worse than misses.

**`assembleWikiLintOutput(input: AssembleWikiLintInput)`** — `total_findings` includes all check counts including `scopeLayers`, `scopeTags`, `indexDrift`, `glossaryConsistency`, `misroutedPrinciples`, and `duplicateTitles`. `filesScanned` counts CLAUDE.md files + agent files + DDD doc files.

## Invariants
<!-- last-updated: 2026-06-12 -->
- All service functions are pure: no I/O except `scanDirectories` and `doc-freshness.ts` (git + fs reads)
- `tools/wiki-lint.ts` is the only file that calls `existsSync` for `checkCitedPaths`; service layer receives an injected `existsOnDisk` predicate (pure-IO split)
- `checkCitedPaths` scans `references/**/*.md` and DDD doc set; `collectDddDocPaths` performs a live filesystem scan (never depends on KG graph store)
- `dddDocFiles` is only loaded when `stale_refs` or `cited_paths` is enabled — no unnecessary filesystem scans for unrelated check subsets
- `checkScopeLayers` is a pure function in `services/wiki-lint.ts`; `tools/wiki-lint.ts` calls `loadLayerMappings(projectDir)` at the I/O boundary and passes `Object.keys(mappings)` as `validLayers` — no I/O in the service
- `checkScopeTags` is a pure function in `services/wiki-lint.ts`; vocabulary (`VALID_COMPUTED_TAGS`) is injected at the tool boundary from `kg-tags.ts` — no I/O in the service; mirrors `checkScopeLayers` in structure
- `index-inventory.ts` is pure except `checkIndexDrift` (clearly separated at the bottom of the file); `sync-indexes.ts` holds all I/O for `sync_indexes`
- `rewriteManagedBlock` returns `{ ok: false }` when sentinel markers are absent — no file is written; `diffIndex` returns `MISSING_MARKERS` when either sentinel is absent

## Conventions
<!-- last-updated: 2026-06-03 -->
- Pure check functions export their helpers (`isExcludedCitedPath`) for direct testing; fence-skip logic is inline in `collectCitedPathsInFile` (not exported) since 2026-06-02
- Recursive scanners thread `originalRoot` through all recursive calls (root-drift bug class prevention)

## Known Expected Noise

**`orphan_principles` residual (~28 findings)**: `orphan_principles` is a DEFAULT check. The tracked `principles/` corpus now uses `[[principle-id]]` wiki cross-links (per the `principles-use-id-crosslinks` convention), so tracked principles are no longer orphans. The **residual ~28 findings are `.canon/principles/` internal principles** (`portable: false`, gitignored) — no committed source can ship inbound links pointing at them. This is an accepted residual, not a regression. A count significantly above ~28 indicates new tracked principles were added without cross-links.
