# shared/lib/ — Agent Reference

## Purpose

Pure utility modules used by feature tools. No MCP dependencies — these are plain TypeScript functions that features import directly. `lib/` is a leaf: these modules may not import from `features/`, `domains/`, or `platform/`.

## Modules

### `commit-trailers.ts` — Canon Git Trailers

Formats git trailer blocks for Canon-managed commits.

**Exports:**
- `TrailerOpts` — `{ workflow: string; agent: string; state: string; taskId?: string }`
- `formatCommitTrailers(opts: TrailerOpts): string` — returns a ready-to-embed trailer block; returns empty string when any required field is missing
- `buildCommitMessage(subject, body, trailerOpts): string` — assembles a full commit message with subject, optional body, trailer block, and `Co-Authored-By` line

**Trailer format:**
```
Canon-Workflow: {slug}
Canon-Agent: {agent-type}
Canon-State: {state-id}
Canon-Task: {task-id}          # wave tasks only (omitted when taskId not provided)
Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
```

**Usage pattern:** Agents receive the pre-formatted trailer block in their spawn prompt. Append it after the commit body, before `Co-Authored-By`.

---

### `file-claims.ts` — Concurrent Workflow File Claims

Manages `.canon/claims.json` — tracks which files are targeted by active workflows. Enables early conflict warnings when concurrent workflows plan changes to the same files.

**Exports:**
- `readClaims(projectDir): ClaimsFile` — reads and returns current claims, pruning entries older than 24h; returns empty structure on any error (never throws)
- `writeClaims(projectDir, claims): void` — atomic write (temp + rename); creates `.canon/` if missing
- `registerClaims(projectDir, workflow, filePaths): void` — idempotent; re-registering the same workflow+file is a no-op
- `releaseClaims(projectDir, workflow): void` — removes all entries for a workflow; no-op for unknown workflows
- `checkClaimOverlaps(projectDir, workflow, filePaths): ClaimOverlap[]` — returns overlapping files from OTHER workflows; same-workflow claims are ignored

**Types:**
- `ClaimsFile` — `{ version: 1; claims: Record<string, ClaimEntry[]> }`
- `ClaimEntry` — `{ workflow: string; claimed_at: string }` (ISO-8601 timestamp)
- `ClaimOverlap` — `{ file_path: string; workflows: string[] }`

**Key patterns:**
- All functions are synchronous (claims file is small, kept in `.canon/`)
- Never throws — all error conditions return empty structures or no-ops
- 24h TTL: stale claims are pruned automatically on every `readClaims` call
- Atomic writes prevent partial reads under concurrent access

**Integration points (do not call directly — orchestration tools handle this):**
- `update_board({ action: "set_metadata", metadata: { affected_files: "..." } })` → calls `registerClaims`
- `update_board({ action: "complete_flow" })` → calls `releaseClaims`
- `init_workspace` preflight → calls `checkClaimOverlaps` and surfaces warnings

## Not Standalone MCP Tools

These modules are consumed by `features/orchestration/` tools. Agents do not call them via MCP — they are wired into `init_workspace` and `update_board` automatically.
