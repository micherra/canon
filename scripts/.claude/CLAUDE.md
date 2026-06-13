# Canon Scripts — Agent Guidelines

## Purpose

Standalone maintainer tools run directly via `bash`. No Canon-runtime coupling — these scripts do NOT invoke `mcp-server/` internals or depend on the MCP server being running.

## Architecture

<!-- last-updated: 2026-06-12 -->
- Bash scripts in this directory are single-file, no external dependencies beyond `gh`, `jq`, `awk`, `xargs`, `grep`, `sed`
- `scripts/lib/` — Node.js ES-module helpers imported by `install-sim-smoke.mjs`; not standalone executables
- Each script is designed to be re-runnable and idempotent
- Output artifacts go to `docs/reference/` (persisted, committed)

## Critical constraints for all scripts in this directory

### Fail-closed (fail-closed-by-default)

Every script must:
1. Start with `set -euo pipefail`
2. Preflight any required external tools (`gh auth status`, etc.) and exit non-zero on failure
3. Never write a partial or empty artifact — if any step fails, exit before writing output

### No eval / no string-executing wrappers

Do NOT use `eval`, `bash -c "<interpolated>"`, or `sh -c "<interpolated>"` over variable content. Canon's `destructive-guard.sh` hook blocks string-executing wrappers over interpolated content. For parallel execution, use a temp wrapper script that sources the main script (the `mine-codex-comments.sh` pattern) rather than `bash -c "$VARIABLE"`.

### Observable (observable-best-effort)

Print progress and error tallies to stderr so re-runs are auditable. Never silently swallow errors that would hide under-counting or missing data.

## Scripts

<!-- last-updated: 2026-06-12 -->
| Script | Purpose |
|--------|---------|
| `mine-codex-comments.sh` | Mine Codex bot PR review comments, cluster into 9 defect classes, write ranked artifact |
| `baseline-orientation-metrics.sh` | Collect session-start metrics (PR count, drift violations, archives) |
| `install-sim-smoke.mjs` | HTTP install-sim smoke test: boots `boot.sh --daemon` on an ephemeral port + throwaway token, connects via `StreamableHTTPClientTransport`, asserts `initialize` + non-empty `listTools`, tears down; `--self-check` runs BROKEN/FIXED/WRONG-PORT sub-tests; Node version guard (#361) retained |
| `lib/install-sim-daemon.mjs` | Daemon lifecycle helpers for install-sim: `pickEphemeralPort`, `startTestDaemon`, `waitForHealth`, `teardownDaemon`, temp-dir/token management |
| `lib/install-sim-http.mjs` | HTTP handshake helpers for install-sim: `resolveHeadersHelper`, `runHeadersHelper`, `attemptHttpHandshake` (StreamableHTTPClientTransport + Client) |

## Testing

Test files are co-located as `*.test.sh`. Run with `bash scripts/<name>.test.sh`. Tests exercise sourceable pure functions (parse/cluster) against fixtures — no live `gh` calls in tests.

Guard pattern: main script guards live-gh execution with:
```bash
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  # live execution only
fi
```

This allows test files to `source` the script and call pure functions without triggering live API calls.
