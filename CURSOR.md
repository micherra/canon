# Cursor-only Canon Runner

This repo’s Canon pipeline can run in Cursor **without** installing the Claude Code plugin.
Cursor uses:
- `AGENTS.md` (Cursor agent instructions / runtime)
- `.cursor/mcp.json` (registers Canon’s MCP server)
- Canon’s existing flow specs (`flows/*.md`) and specialist specs (`agents/*.md`)

## Prerequisites

1. Node.js 24+ (for the MCP server)
2. Install MCP server dependencies:
```bash
cd mcp-server
npm install
```

## Cursor configuration

1. Ensure this file exists and is committed:
   - `.cursor/mcp.json`
2. Restart Cursor so it loads the project MCP config.
3. In Cursor, your chat agent should have access to the MCP server tools exported by Canon (e.g. `get_principles`, `review_code`, `get_file_context`, `report`).

## How to run Canon in Cursor

You do not need special plugin commands. Just ask for a Canon action in chat, for example:
- `Add an auth-protected dashboard with Zod validation`
- `Review my changes`
- `Security scan for vulnerabilities`
- `Resume where we left off`

When Canon is triggered, the Cursor-side runner will:
1. Create a branch-scoped workspace under:
   - `.canon/workspaces/{sanitized-branch}/`
2. Create `board.json`, `session.json`, `progress.md` (if the flow uses it), and `log.jsonl`
3. Drive the state machine using the flow templates, then write flow artifacts under:
   - `.canon/workspaces/{sanitized-branch}/plans/{slug}/...`

## Resume behavior

The runner persists state in `board.json`. To continue an interrupted run:
- ask `resume`

The pipeline will re-enter the `board.current_state` for that workspace.

## Rollback / HITL

If a state transitions to `hitl` (blocked, merge conflict, unresolved questions, etc.), the runner will:
- present options including `retry`, `skip`, `rollback` (destructive), `abort`, and `manual-fix`
- use `git revert` to roll back to `board.base_commit` for destructive rollback

## Installing into another repo (bundle)

If you need to install via a prebuilt bundle, create it here with:

- `bash scripts/create-canon-cursor-bundle.sh`

Then install via the published `canon-cursor` npm package (preferred):
- `npx -y canon-cursor`

## Installing via `npx`

You can also run the same logic via a Node CLI (no root `package.json` required):

- Create bundle:
  - `npx --no-install ./scripts/canon-cursor-cli.mjs bundle`
- Install into the current repo:
  - `npx --no-install ./scripts/canon-cursor-cli.mjs install --bundle-path /path/to/canon-cursor-everything.tgz --force`
  - `npx --no-install ./scripts/canon-cursor-cli.mjs install --bundle-url https://example.com/canon-cursor-everything.tgz --force`

## Installing via `npx canon-cursor` (published package)

If/when the `canon-cursor` npm package is published, target users can install with:

- `npx -y canon-cursor`
- `npx -y canon-cursor --force`

After installing, restart Cursor and run a Canon action in chat.

