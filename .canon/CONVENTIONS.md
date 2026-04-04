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
