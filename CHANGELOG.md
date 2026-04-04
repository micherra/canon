# Changelog

All notable changes to Canon are documented here.

---

## [Unreleased]

### Changed

- Restructured repository layout to consolidate documentation under `docs/`

---

## Repository Restructuring (Phases 0–2)

### Phase 2 — Root docs cleanup

- Moved `CANON-REFERENCE.md` → `docs/reference/canon-reference.md`
- Moved `images/` → `docs/images/`
- Added `context.md` to `.gitignore` (ephemeral workspace artifact, not source)
- Updated `README.md` image paths to reference `docs/images/`
- Updated `CLAUDE.md` reference to point to new `docs/reference/canon-reference.md` location

### Phase 1 — Plugin directory conventions

- Renamed `.claude/subagents/` → `.claude/agents/` per Claude Code convention
- Fixed plugin directory layout: `agents/`, `rules/`, `hooks/hooks.json`
- Corrected stale path references throughout
- Fixed CANON-REFERENCE.md tree diagram

### Phase 0 — Initial repository setup

- Established Canon plugin structure with MCP server, flows, principles, skills, agents, hooks, and templates
- Migrated cursor-extension to MCP App served by the MCP server
