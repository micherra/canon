# Canon Cursor CLI — Project Guidelines

<!-- Managed by Canon. Manual edits are preserved. -->

## Purpose
npm package that bootstraps the Canon runner system into any repository via `npx canon-cursor`. Extracts a pre-built bundle containing agents, MCP server, flows, rules, and templates.

## Architecture
<!-- last-updated: 2026-03-22 -->

Zero-dependency Node.js CLI (ES modules). No npm dependencies — uses only Node.js built-ins.

```
canon-cursor-cli/
├── bin/
│   └── cli.mjs               # Main CLI entry point (executable)
├── bundle/
│   └── canon-cursor-everything.tgz  # Embedded bundle (created at build time)
├── scripts/
│   └── prepare-bundle.mjs    # Build script to prepare bundle
├── package.json
└── README.md
```

**Installation flow:**
1. Parse args (`--force`, `--bundle-path`, `--bundle-url`, `--help`)
2. Locate bundle (embedded, local path, or remote URL)
3. Extract via system `tar -xzf` to temp staging directory
4. Copy 19 items into target repo (skip existing unless `--force`)
5. Report installed items, prompt user to restart Cursor

## Contracts
<!-- last-updated: 2026-03-22 -->

**CLI interface:**
```bash
npx -y canon-cursor              # Install (skip existing files)
npx -y canon-cursor --force      # Overwrite existing files
npx -y canon-cursor --bundle-path /path/to/file.tgz
npx -y canon-cursor --bundle-url https://...
```

**Installed items:** AGENTS.md, CURSOR.md, CLAUDE.md, .cursor/mcp.json, .mcp.json, .cursor/agents, .cursor/hooks, mcp-server/, flows/, agents/, agent-rules/, principles/, templates/, hooks/, commands/, cursor-extension/

## Dependencies
<!-- last-updated: 2026-03-22 -->

No npm dependencies. Requires system `tar` command and Node.js 24+.

**Build prerequisite:** The parent repo must first run `scripts/create-canon-cursor-bundle.sh` to generate `dist/canon-cursor-everything.tgz`.

## Development
<!-- last-updated: 2026-03-22 -->

```bash
npm run build    # Copies dist/canon-cursor-everything.tgz → bundle/
npm publish      # Publish to npm with embedded bundle
```
