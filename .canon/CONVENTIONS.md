## Project Conventions

> Project-specific patterns and decisions. Auto-detected by init and refined as the project evolves.
> Implementor agents read this file alongside Canon principles.

- **Language**: TypeScript (ES modules) with Node.js 24+
- **Naming**: camelCase for functions and variables, PascalCase for types and interfaces
- **File naming**: kebab-case for files and directories
- **Module structure**: One tool per file in `tools/`, one subsystem per directory (`drift/`, `graph/`, `utils/`)
- **Schema validation**: Zod schemas at API/tool boundaries
- **Testing**: Vitest with co-located `__tests__/` directories
- **Error handling**: Custom error utilities in `utils/errors.ts`
- **Data persistence**: JSONL files in `.canon/` with atomic writes
- **Imports**: Explicit `.js` extensions for ES module imports
- **Frontend**: Svelte (mcp-server/ui), served as MCP App via ext-apps SDK; Sigma.js + Graphology for graph rendering (WebGL, ForceAtlas2 layout, Louvain community detection); D3 removed
