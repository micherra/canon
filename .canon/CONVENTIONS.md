## Project Conventions

> Project-specific patterns and decisions. Auto-detected by init and refined as the project evolves.
> Implementor agents read this file alongside Canon principles.

- **Language**: TypeScript (ES modules) with Node.js 25.x (pinned to 25.8.0 in .tool-versions)
- **Naming**: camelCase for functions and variables, PascalCase for types and interfaces
- **Functions**: Prefer arrow functions (`const foo = () => {}`) over function declarations; exception: exported functions that need hoisting
- **File naming**: kebab-case for files and directories
- **Module structure**: One tool per file in `tools/`, one subsystem per directory (`drift/`, `graph/`, `utils/`)
- **Schema validation**: Zod schemas at API/tool boundaries
- **Testing**: Vitest with co-located `__tests__/` directories
- **Error handling**: Tool functions return `ToolResult<T>` (from `utils/tool-result.ts`) for expected errors — no throwing; unexpected errors caught by `wrapHandler` and returned as `UNEXPECTED` `CanonToolError`; `utils/errors.ts` for internal path/file utilities
- **Data persistence**: JSONL files in `.canon/` with atomic writes for reviews/drift; SQLite KG (`knowledge-graph.db`) via `KgQuery`/`KgStore` is the primary store for graph and summary data — `summaries.json` no longer written (ADR-005); `graph-data.json` and `reverse-deps.json` still written as materialized views pending full ADR-005 migration
- **Imports**: Explicit `.ts` extensions for TypeScript ES module imports (matching Vitest/tsx execution)
- **Frontend**: Svelte (mcp-server/src/ui), served as MCP App via ext-apps SDK; Sigma.js + Graphology for graph rendering (WebGL, ForceAtlas2 layout, Louvain community detection); D3 removed
- **KG file context formatting**: Use `buildKgFileEntries(filePaths, db)` + `formatKgFileContext(entries, heading?)` from `mcp-server/src/features/orchestration/services/kg-context-formatter.ts` — never format KG metrics inline. The formatter returns raw unescaped text; callers apply `escapeDollarBrace()` at their own trust boundary.
- **Flow YAML context injection**: Implement/execute states in all primary build flows (feature, fast-path, refactor, epic, migrate) declare `inject_context: [{from: file_context, as: file_context}]` to activate KG-backed file affinity injection. This is now the standard pattern — add it when creating new build flows.
- **Enrichment tier**: Always read session tier from `getExecutionStore(workspace).getSession()?.tier ?? "medium"` — never from `flow.tier` (which is optional and rarely set in YAML).
- **Criteria Coverage table**: All implementation logs must include a populated `#### Criteria Coverage` table mapping every task-plan acceptance criterion to what was implemented. Use disposition vocabulary: `covered` (fully addressed), `descoped` (intentionally omitted with rationale), `partial` (addressed in part — state what remains). A missing or empty table is a summary defect; the reviewer flags it in Stage 3.
- **Learning log triage cadence**: Learning log suggestions are triaged every 5 soak runs. Suggestions older than 5 runs that remain unactioned are either applied, deferred with rationale, or closed as stale.
