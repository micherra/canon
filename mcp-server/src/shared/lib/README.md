# shared/lib/ — Shared Utility Library

Low-level, single-concern utility modules. No MCP dependencies. All exports are pure functions or types. Features import from here directly.

## Modules

### `commit-trailers.ts`

Formats git trailer blocks for Canon agent provenance. Every Canon-managed commit includes trailers identifying the originating workflow, agent, and state.

**Trailer format:**
```
Canon-Workflow: {slug}
Canon-Agent: {agent-type}
Canon-State: {state-id}
Canon-Task: {task-id}
Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
```

Trailers are queryable via standard git tooling:
```bash
git log --grep='Canon-Workflow: my-slug'
git log --grep='Canon-Agent: canon-implementor'
```

Key exports: `formatCommitTrailers`, `buildCommitMessage`, `TrailerOpts`

---

### `file-claims.ts`

Manages `.canon/claims.json` for concurrent workflow coordination. When two workflows plan changes to the same files, `init_workspace` preflight surfaces a warning so the user can decide whether to proceed.

Claims are **advisory only** — they never block workspace creation. They are registered automatically when the architect sets `affected_files` via `update_board`, and released automatically when `update_board` completes a flow.

Key features:
- 24-hour TTL: stale claims auto-pruned on read
- Atomic writes: temp-then-rename prevents partial reads
- Never throws: all error conditions return empty structures

Key exports: `readClaims`, `writeClaims`, `registerClaims`, `releaseClaims`, `checkClaimOverlaps`

`.canon/claims.json` format:
```json
{
  "version": 1,
  "claims": {
    "path/to/file.ts": [
      { "workflow": "slug", "claimed_at": "2026-04-09T00:00:00Z" }
    ]
  }
}
```

---

## Architecture Notes

Both modules are:
- **Pure / sync** — no async I/O, no MCP dependencies
- **Called by orchestration tools** — not exposed as MCP tools directly
- **Leaf dependencies** — do not import from `features/`, `domains/`, or `platform/`

See `docs/reference/canon-reference.md` for full tool-level documentation including the Agent Provenance section.
