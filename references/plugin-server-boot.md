# Plugin-bundled MCP Server Boot Pattern

Canon's MCP server follows the official Claude plugins-reference pattern for plugin-bundled Node.js servers with dependencies. The rules are non-obvious enough that they warrant a dedicated reference. Violating any one of them produces a failure that either silently does nothing (ESM NODE_PATH trap) or surfaces as a cold-cache registry lookup at the worst possible time (npx).

Source: https://code.claude.com/docs/en/plugins-reference §"Persistent data directory"  
Implemented: PR #287 (original pattern), PR #296 (ESM co-location fix)

---

## 1. Deps target `${CLAUDE_PLUGIN_DATA}`, never `${CLAUDE_PLUGIN_ROOT}`

The marketplace cache (`${CLAUDE_PLUGIN_ROOT}`) is version-keyed and ephemeral — it is garbage-collected approximately 7 days after a plugin update. Installing `node_modules` there means they disappear on the next version bump.

`${CLAUDE_PLUGIN_DATA}` is the persistent data directory. It survives plugin updates. This is the correct install target.

```bash
DATA="${CLAUDE_PLUGIN_DATA}"
```

`npm install` in `$DATA` creates `$DATA/node_modules`; boot.sh references that path as `DATA_DIR`.

---

## 2. Compare-manifest SessionStart install

The plugins-reference recipe: diff the server's `package.json` against the copy stored in PLUGIN_DATA; reinstall only when they differ.

```bash
if ! diff -q "$MCP_DIR/package.json" "$DATA/package.json" >/dev/null 2>&1; then
  cd "$DATA" && cp "$MCP_DIR/package.json" . && npm install --no-audit --no-fund
fi
```

**On failure**: remove the stored manifest so the next session retries cleanly:
```bash
rm -f "$DATA/package.json"
```

**Always exit 0**: SessionStart hooks are advisory. An install failure must not block the session.

Canon's implementation: `hooks/canon-agent-teams/session-start-deps-install.sh`

---

## 3. Self-resolving launcher

`${CLAUDE_PLUGIN_ROOT}` is expanded by the platform when a plugin's `.mcp.json` is the active config. When `.mcp.json` is loaded as a **project config** (i.e. checked into a repo), `${CLAUDE_PLUGIN_ROOT}` is passed through as a literal token — it is never expanded.

The backstop is `BASH_SOURCE` self-resolution. The launcher (`boot.sh`) lives inside `mcp-server/`, so its parent directory is always the server dir regardless of load context:

```bash
if [[ -n "${CLAUDE_PLUGIN_ROOT:-}" ]] && [[ -d "${CLAUDE_PLUGIN_ROOT}/mcp-server" ]]; then
  SERVER_DIR="${CLAUDE_PLUGIN_ROOT}/mcp-server"
else
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  SERVER_DIR="$SCRIPT_DIR"
fi
```

The `.mcp.json` entry uses the expansion-safe form `bash ${CLAUDE_PLUGIN_ROOT:-.}/mcp-server/boot.sh` — the `:.` default means "current directory" when the variable is unset, making BASH_SOURCE resolution the effective path.

---

## 4. ESM dep resolution: the NODE_PATH pitfall (LLLL1)

> **This is the most common boot failure on a clean profile install. The failure is silent until the MCP initialize handshake.**

`NODE_PATH` is a CommonJS-only mechanism. Node's ESM `import` resolver **ignores `NODE_PATH` entirely**. Instead, it directory-walks up the filesystem looking for `node_modules` directories.

Canon's MCP server has `"type":"module"` in its `package.json`. It is a full ESM project. Routing deps via `NODE_PATH` works for any CJS transitive deps but silently does nothing for ESM `import` statements. The server crashes at the MCP `initialize` handshake (~4 seconds into startup) with `ERR_MODULE_NOT_FOUND`.

**Empirical verification (Node v25.8.0):**
```
NODE_PATH=$DATA/node_modules node app.mjs  → ERR_MODULE_NOT_FOUND
ln -s $DATA/node_modules $SERVER/node_modules && node app.mjs  → resolved
```

**The correct mechanism: a co-located symlink**

Create `$SERVER_DIR/node_modules → $CLAUDE_PLUGIN_DATA/node_modules` on every launch:

```bash
if [[ -n "${DATA_DIR:-}" ]] && [[ -x "${DATA_DIR}/.bin/tsx" ]]; then
  if [[ ! -e "${SERVER_DIR}/node_modules" ]] || [[ -L "${SERVER_DIR}/node_modules" ]]; then
    rm -f "${SERVER_DIR}/node_modules"
    ln -s "$DATA_DIR" "${SERVER_DIR}/node_modules"
  fi
fi
```

Key properties:
- **Portable `rm -f` + `ln -s` is idempotent** — `rm -f` removes only a symlink or absent path (never a real directory); `ln -s` then creates a fresh link. Survives cache wipes. Avoids the GNU/BSD `ln -sfn`/`-n` divergence and the foot-gun where `ln -sf` follows an existing symlink-to-directory and nests the new link inside the target instead of replacing it.
- The `[[ ! -e ]] || [[ -L ]]` guard **never clobbers a real `node_modules` directory** (dev working tree). It replaces only absent entries or existing symlinks.
- `ln` failure emits `CANON WARNING` and degrades gracefully (ESM imports may fail, but boot does not exit 1 — the dangling-symlink guard below handles the fatal case).

`NODE_PATH` is still exported for any CJS transitive deps that need it, but it is not the ESM load-path mechanism.

---

## 5. Deps-ready poll and dangling-symlink guard

*Snippets below are illustrative — see `mcp-server/boot.sh` for the runnable, fully-guarded form (variable init, `--print-resolution` short-circuit).*

### Pre-poll stale-link clear (step 5 in boot sequence)

A prior boot may have left `$SERVER_DIR/node_modules` as a symlink to `DATA_DIR`. If the cache was subsequently wiped, that symlink now dangles (the target no longer exists). Without clearing it first, the deps-ready poll below would stall for the full timeout even though both the link and DATA_DIR are missing tsx — the poll watches `DATA_DIR/.bin/tsx` directly, but the stale dangling link would be re-evaluated by the fail-closed guard only after the wait, producing a confusing full-timeout delay before the loud exit.

Guard condition: `[[ -L $SERVER_DIR/node_modules ]] && [[ ! -d $SERVER_DIR/node_modules ]] → rm -f`. Real `node_modules` directories (`-L` is false) and absent paths are untouched. Skipped under `--print-resolution` (keep that instant and side-effect-free).

### Deps-ready poll

The SessionStart install script runs asynchronously. On a clean profile, `boot.sh` may launch before deps are installed (~26s gap). The poll closes this race:

```bash
# Poll up to CANON_BOOT_DEPS_TIMEOUT ticks (default 60, interval CANON_BOOT_DEPS_INTERVAL default 1s)
while [[ ! -x "${DATA_DIR}/.bin/tsx" ]] && (( elapsed < TIMEOUT )); do
  sleep "$INTERVAL"
  elapsed=$(( elapsed + 1 ))
done
# On exhaustion, fall through to the tsx-absent exit below.
```

Env seams for testing: `CANON_BOOT_DEPS_TIMEOUT` (default 60), `CANON_BOOT_DEPS_INTERVAL` (default 1).

The `--print-resolution` flag short-circuits the poll (instant, deterministic; used by tests and debug).

### Dangling-symlink guard

`[[ -d path ]]` follows symlinks — it returns false for a dangling link. This makes it an effective guard against booting when PLUGIN_DATA was wiped between launches:

```bash
if [[ -L "${SERVER_DIR}/node_modules" ]] && [[ ! -d "${SERVER_DIR}/node_modules" ]]; then
  echo "CANON ERROR: node_modules symlink does not resolve (PLUGIN_DATA wiped?); refusing to boot" >&2
  exit 1
fi
```

Refusing to boot is correct here: continuing would produce `ERR_MODULE_NOT_FOUND` at the MCP handshake, which is harder to diagnose than a loud early exit.

---

## 6. Never npx

Cold-cache `npm` registry lookups are a root cause class for boot failures. They depend on network, registry availability, and local cache state — none of which are guaranteed in plugin context.

Always use the pinned local `tsx` binary resolved from deps:

```bash
exec "${TSX_BIN}" src/app/index.ts
```

Where `TSX_BIN` is resolved from `${NODE_PATH}/.bin/tsx` or `${SERVER_DIR}/node_modules/.bin/tsx` — never `npx tsx`.

---

## Boot sequence summary

```
boot.sh
  1. Parse flags (--print-resolution, --force-dir)
  2. Resolve SERVER_DIR (CLAUDE_PLUGIN_ROOT → BASH_SOURCE fallback)
  3. Sanity-check: SERVER_DIR/src/app/index.ts must exist
  4. Compute DATA_DIR = ${CLAUDE_PLUGIN_DATA}/node_modules
  5. Clear stale dangling symlink (rm -f if SERVER_DIR/node_modules is a dangling link; skip under --print-resolution)
  6. Deps-ready poll (skip if co-located tsx already present, or --print-resolution)
  7. ESM co-location symlink: rm -f + ln -s DATA_DIR SERVER_DIR/node_modules
  8. Dangling-symlink guard: exit 1 if symlink does not resolve
  9. Resolve NODE_PATH (PLUGIN_DATA first, co-located fallback)
 10. Resolve TSX_BIN
 11. --print-resolution: print "SERVER_DIR NODE_PATH TSX_BIN", exit 0
 12. tsx-absent fail-closed: exit 1 with loud message
 13. Observability log + exec TSX_BIN src/app/index.ts
```

---

## Pitfalls

### ESM import ignores NODE_PATH (most common)

**Symptom**: Server boots without error but crashes at the MCP `initialize` handshake with `ERR_MODULE_NOT_FOUND`. `boot.sh` exits cleanly; the crash is ~4s later.

**Cause**: The server is `"type":"module"`. `NODE_PATH` is CommonJS-only. Node's ESM `import` resolver does not read `NODE_PATH`.

**Fix**: Ensure the co-located symlink `$SERVER_DIR/node_modules → $PLUGIN_DATA/node_modules` exists. `boot.sh` creates it on every launch, but `ln` failure degrades to a warning. Check for the warning in stderr and investigate whether `SERVER_DIR` is read-only.

### CLAUDE_PLUGIN_ROOT is a literal token in project config

**Symptom**: `boot.sh` cannot find `src/app/index.ts`. BASH_SOURCE resolution is the backstop — verify `boot.sh` is actually located at `mcp-server/boot.sh` relative to the server source.

### Deps installed into CLAUDE_PLUGIN_ROOT (wrong target)

**Symptom**: Deps disappear after a plugin version bump. The marketplace GC's the old version directory.

**Fix**: Install into `${CLAUDE_PLUGIN_DATA}` (persists across updates), never into `${CLAUDE_PLUGIN_ROOT}` (version-keyed cache).

### SessionStart install race (clean profile)

**Symptom**: Boot fails on first launch with "tsx not found", then succeeds on second launch after deps have installed.

**Cause**: `boot.sh` launched before the SessionStart install completed. The deps-ready poll (step 6) closes this race. If `CANON_BOOT_DEPS_TIMEOUT` is too short, increase it.

### Dangling symlink after PLUGIN_DATA wipe

**Symptom**: `CANON ERROR: node_modules symlink does not resolve` + exit 1.

**Cause**: `PLUGIN_DATA` was cleared (plugin reinstall, manual cache wipe) but the symlink in `SERVER_DIR` still points to the old location.

**Fix**: The next SessionStart install recreates `PLUGIN_DATA/node_modules`, after which `boot.sh`'s `rm -f` + `ln -s` step (step 7) recreates a valid symlink.

---

## See also

- `mcp-server/boot.sh` — implementation
- `hooks/canon-agent-teams/session-start-deps-install.sh` — SessionStart install hook
- `mcp-server/.claude/CLAUDE.md` §Contracts `boot.sh` entry — contract-level summary
- https://code.claude.com/docs/en/plugins-reference §"Persistent data directory" — official recipe
