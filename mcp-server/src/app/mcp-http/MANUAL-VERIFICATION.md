# Canon HTTP MCP — Manual Verification Pack (AC8)

This document is the hand-off artifact for the AC8 manual-verify HITL gate. It
provides copy-paste steps to verify the HTTP MCP daemon end-to-end in a live
Claude Code session with a real interactive client.

**Validated environment:** macOS, Claude Code 2.1.167, SDK 1.29.0, Canon 2.6.0.

---

## Prerequisites

- Canon MCP server is installed and `mcp-server/` is built (`npm run build` in
  `mcp-server/`).
- You are in the Canon repo root.

---

## Step 1 — Enable the HTTP daemon flag

```bash
export CANON_HTTP_DAEMON=1
```

The supervisor hook (`hooks/canon-agent-teams/session-start-daemon-supervisor.sh`)
reads this flag on every Claude Code session start. When set to `1`, it starts the
daemon (or validates an already-running one). When unset or `0`, it is a no-op.

---

## Step 2 — Start the daemon (two options)

### Option A — Via Claude Code session start (recommended)

Simply start a new Claude Code session. The supervisor hook fires automatically
and starts the daemon on port 3142 in the background.

Check the daemon is running:

```bash
curl -s http://127.0.0.1:3142/health | python3 -m json.tool
# Expected: {"ok": true, "port": 3142, "transport": "http", "version": "2.6.0"}
```

### Option B — Direct daemon start (for isolated testing)

```bash
bash mcp-server/boot.sh --daemon
```

The `--daemon` flag sets `CANON_HTTP_DAEMON=1` internally and starts the daemon
process. Output goes to stderr. The daemon runs in the foreground — use `&` to
background it if needed, or open a separate terminal.

---

## Step 3 — Read the auth token

The daemon generates a token on first boot and stores it at:

```bash
TOKEN_PATH="${CLAUDE_PLUGIN_DATA:-$HOME/.claude/canon}/canon-mcp-token"
TOKEN=$(cat "$TOKEN_PATH")
echo "Token: $TOKEN"
```

Copy the token value — you will paste it into the `.mcp.json` config below.

---

## Step 4 — Create a scratch `.mcp.json` config

**Do NOT commit this file.** Place it in your home directory or a scratch
location, not in the repo.

```bash
cat > /tmp/canon-http-scratch.mcp.json << 'EOF'
{
  "mcpServers": {
    "canon-http": {
      "type": "http",
      "url": "http://127.0.0.1:3142/mcp",
      "headers": {
        "Authorization": "Bearer <paste token here>"
      }
    }
  }
}
EOF
```

Replace `<paste token here>` with the token from Step 3.

---

## Step 5 — Start a Claude Code session with the HTTP config

```bash
claude --mcp-config /tmp/canon-http-scratch.mcp.json
```

Or, for the project `.mcp.json` (also NOT committed — use `.gitignore`):

```json
{
  "mcpServers": {
    "canon-http": {
      "type": "http",
      "url": "http://127.0.0.1:3142/mcp",
      "headers": {
        "Authorization": "Bearer <paste token here>"
      }
    }
  }
}
```

---

## Step 6 — Verify tools are available

In the Claude Code session, run:

```
/mcp
```

Expected: `canon-http` server listed with 42+ tools. Confirm the tool list
includes entries like `init_workspace`, `list_principles`, `get_file_context`.

---

## Step 7 — Verify scoped tool call

Call `list_principles` (read-only, no side effects):

> Use the `list_principles` tool from the `canon-http` server.

Expected: list of Canon principles returned without error.

Then call `init_workspace` to verify that workspace writes land in the **current
repo's `.canon/` directory**, not a wrong dir:

> Use the `init_workspace` tool with `flow_name: "http-manual-verify"`,
> `task: "http-manual-verify"`, `branch: "manual-test"`, `base_commit: "HEAD"`,
> `tier: "small"`, `original_input: "manual AC8 verification"`.

After the call, verify the workspace was created in the correct location:

```bash
ls .canon/workspaces/ | grep "http-manual-verify"
# Expected: a directory named after the workspace slug
```

---

## Step 8 — Verify roots/list scope resolution

The Canon HTTP daemon resolves project scope via two paths:

**Path A — `x-canon-project-dir` header** (used by this `.mcp.json` config when
an explicit header is set; bypasses roots/list).

**Path B — roots/list** (used when no `x-canon-project-dir` header is present;
the server requests the client's roots). This is the interactive-session path.

To test Path B (roots/list), remove the `x-canon-project-dir` header from your
`.mcp.json` and restart Claude Code. The daemon will call `roots/list` on your
client and resolve scope from the first root URI.

**Live check (Path B):**

1. Edit `/tmp/canon-http-scratch.mcp.json` — remove any `x-canon-project-dir`
   header from the `headers` object (or use the repo's `.mcp.json` which uses
   `headersHelper` with no `x-canon-project-dir`).
2. Restart Claude Code with `--mcp-config /tmp/canon-http-scratch.mcp.json`.
3. Call `list_principles` or `init_workspace` as in Step 7.

**Expected result:** The tool succeeds and workspace writes land in the Canon repo
directory (the client's working directory at session start). The daemon answered
`roots/list` with the client cwd as a `file://` URI and resolved scope from it.

> **RESOLVED (2026-06-11):** A fresh INTERACTIVE Claude Code session launched with
> `--mcp-config` pointing at the HTTP daemon config (HTTP transport, `headersHelper`,
> NO `x-canon-project-dir` header) against the live daemon v2.12.0 successfully
> resolved project scope via `roots/list` and returned results from
> `mcp__canon__list_principles`. The interactive client DOES answer `roots/list`.
> **Path B (roots/list) is the confirmed interactive-session path for Phase 3.
> The residual risk is RESOLVED.**

> **Note (headless client):** The headless client (`claude -p`, `--strict-mcp-config`)
> also answers `roots/list` as validated by PROBE-FINDINGS.md (2026-06-06,
> Claude Code 2.1.167). Both interactive and headless paths are confirmed.

---

## Step 9 — Record the outcome

After completing Steps 6–8, record the result in the build workspace:

```bash
# Pass:
echo "AC8: PASS — interactive client resolved scope via roots/list (Path B)" \
  >> .canon/workspaces/<slug>/notes.txt

# Fallback path (Path A required):
echo "AC8: PARTIAL — roots/list not answered; x-canon-project-dir header required" \
  >> .canon/workspaces/<slug>/notes.txt
```

---

## Step 10 — Cleanup

Stop the daemon:

```bash
PID_FILE="${CLAUDE_PLUGIN_DATA:-$HOME/.claude/canon}/canon-daemon.pid"
if [ -f "$PID_FILE" ]; then
  DAEMON_PID=$(head -1 "$PID_FILE")
  kill "$DAEMON_PID" && echo "Daemon stopped (PID $DAEMON_PID)"
  rm -f "$PID_FILE"
else
  echo "No PID file found — daemon may already be stopped"
fi
```

Remove the scratch config:

```bash
rm -f /tmp/canon-http-scratch.mcp.json
```

Unset the flag:

```bash
unset CANON_HTTP_DAEMON
```

Remove the test workspace if desired:

```bash
rm -rf .canon/workspaces/*http-manual-verify*
```

---

## F1 residual same-user risk — accepted (threat-model sign-off)

**Date accepted:** 2026-06-11

### What F1 hardening provides

The mechanical hardening shipped in F1 (`O_EXCL` exclusive token creation + `0700`
parent directory + fail-closed `EEXIST`) defends against the following adversary
classes:

- **Token-LESS adversary**: a process that attempts to connect to the daemon without
  a token is rejected (401).
- **Pre-plant adversary**: an attacker who creates the token file before the daemon
  starts is blocked by `O_EXCL` — the daemon exits rather than accepting a
  pre-planted token.
- **Clobber / replace adversary**: overwriting the token file after daemon start has
  no effect — the daemon reads the token once at startup via `loadOrCreateToken`.
- **Symlink adversary**: `O_EXCL` on a target that exists (including a symlink
  target) causes the create to fail.

### What F1 hardening does NOT provide

**Same-user process isolation is NOT provided by the TCP+token transport.** A
process running as the same OS user can:

1. Read the `0600` token file (same-user ACL permits read).
2. Present the token in a `Authorization: Bearer` header to the loopback TCP port.
3. Receive a valid MCP session with full tool access.

This is an **accepted, documented asymmetry** versus the stdio transport it replaces.
The stdio transport's parent-child pipe is unaddressable and unreadable by an
unrelated same-user process — it inherently provides same-user process isolation.
The TCP+token transport cannot provide this property: any process running as the same
user has filesystem read access to the token.

### Decision: accepted

This asymmetry is accepted for the following reasons:

- The threat is bounded to **same-user processes on the same host** (loopback-only
  binding, remoteAddress guard, Host-header DNS-rebinding guard all applied).
- The Canon MCP server is a **local developer tool** — the threat model for same-user
  local processes is equivalent to the threat model for any other local developer
  tooling (e.g., language servers, build daemons) that stores secrets in `$HOME`.
- The stdio transport provided same-user isolation as a **side effect** of UNIX pipe
  semantics, not by design. Reproducing this property over TCP would require a
  unix-domain socket.

### Architecturally-complete fix (blocked upstream)

The durable fix is to replace the TCP+token transport with a **unix-domain socket at
`0600`** (`/tmp/canon-mcp-NNNNN.sock` or `$CLAUDE_PLUGIN_DATA/canon-mcp.sock`). A
0600 unix-domain socket ties authorization to filesystem ACLs and eliminates the
readable-secret entirely — only the owning user can connect at the OS level, without
a token.

**Blocked upstream today**: Claude Code's `.mcp.json` schema and the MCP TypeScript
SDK have no unix-socket transport type. Until the upstream supports unix-socket
transports, the TCP+token transport is the only available option for the HTTP daemon
path. This is filed as a future durable-fix epic and must be revisited when upstream
support lands.

---

## Summary of expected outcomes

| Check | Expected |
|-------|----------|
| `/health` endpoint | `{"ok":true,"port":3142,"transport":"http","version":"2.6.0"}` |
| Tools available in session | 42+ tools from `canon-http` server |
| `list_principles` | Returns principle list, no error |
| `init_workspace` writes | Land in current repo's `.canon/workspaces/` |
| `roots/list` Path B | Scope resolves without `x-canon-project-dir` header — CONFIRMED (interactive + headless, 2026-06-11, Claude Code 2.1.167, daemon v2.12.0) |
| Cleanup | Daemon stopped, PID file removed, scratch config deleted |

---

## Post-cutover default transport — operational reference (T-FLIP)

**Date flipped:** 2026-06-11. `.mcp.json` in the repo root now connects the `canon`
MCP server to `http://127.0.0.1:3142/mcp` via `headersHelper`. This section
documents the operational behavior after the flip.

### Default configuration (repo `.mcp.json`)

```json
{
  "mcpServers": {
    "canon": {
      "type": "http",
      "url": "http://127.0.0.1:3142/mcp",
      "headersHelper": "${CLAUDE_PLUGIN_ROOT:-.}/mcp-server/mcp-auth-headers.sh"
    }
  }
}
```

The `headersHelper` script (`mcp-auth-headers.sh`) resolves the auth token
dynamically at connection time. **No token literal is committed** — the helper
provides the `Authorization: Bearer <token>` header by reading the token file
(see Token-path dependency below).

### Down-daemon failure mode (fail-closed)

If the daemon is not running when Claude Code starts:

- Claude Code reports the `canon` MCP connection as **FAILED** (visible in `/mcp`
  output and session start warnings). This is an explicit, observable failure.
- All `mcp__canon__*` tools are **unavailable** for the session.
- **There is no stdio fallback.** The flip is a hard transport swap; the stdio
  `command`/`args`/`env` block is removed entirely by design (DEC-03, fail-closed).
- Silence or hang is not the failure mode — Canon chose fail-loudly observable
  failure over silent degradation.

### Recovery paths

1. **Automatic (recommended)**: The SessionStart supervisor
   (`hooks/canon-agent-teams/session-start-daemon-supervisor.sh`) restarts the
   daemon automatically on the next Claude Code session start when
   `CANON_HTTP_DAEMON=1`. Ensure this env var is set in your shell profile.

2. **Manual**: Start the daemon directly:
   ```bash
   bash mcp-server/boot.sh --daemon
   ```
   Then use `/mcp` in Claude Code to reconnect.

### Emergency kill-switch (DEC-03)

To revert to stdio transport immediately:

1. Unset the daemon flag: `unset CANON_HTTP_DAEMON`
2. Revert `.mcp.json` to the stdio `command` form (git history has the prior form).
3. Restart Claude Code — it will use the stdio transport directly.

No daemon process will be started; all tools route through the stdio subprocess.

### Plugin distribution and migration (DEC-04)

This flip changes the **default transport for every Canon install** when users
update the plugin. Behavior on plugin update:

- The new `.mcp.json` (HTTP form) takes effect on next Claude Code session start.
- The daemon is started by the SessionStart supervisor when `CANON_HTTP_DAEMON=1`.
- Users without `CANON_HTTP_DAEMON=1` will see a connection failure until they set
  the flag. The error is explicit (see Down-daemon failure mode above).
- This change rides a plugin version bump (release-please). The PR body for this
  ship must call out the transport change and the `CANON_HTTP_DAEMON=1` requirement.

### Token-path runtime dependency (REQUIRED precondition — live finding 2026-06-11)

The `headersHelper` resolves the auth token via `auth.ts resolveTokenPath` with the
following tier priority:

1. `$CANON_MCP_TOKEN_FILE` (explicit override)
2. `$CLAUDE_PLUGIN_DATA/canon-mcp-token` **(Tier 2 — used by supervisor-launched daemon)**
3. `$HOME/.claude/canon/canon-mcp-token` (Tier 3 — fallback)

**Live verification finding (2026-06-11):** The supervisor-launched daemon writes and
reads the **Tier 2 token** (`$CLAUDE_PLUGIN_DATA/canon-mcp-token`). When the
headersHelper is invoked by Claude Code, it must use the same Tier 2 token to
authenticate successfully (Tier-2 token → HTTP 200; a stale Tier-3 HOME token → 401).

**Required precondition:** `CLAUDE_PLUGIN_DATA` must be present in the environment
when Claude Code invokes the headersHelper. The plugin-shipped `.mcp.json` is
evaluated in an environment where `${CLAUDE_PLUGIN_ROOT}` and `${CLAUDE_PLUGIN_DATA}`
are set (the prior stdio form already depended on `${CLAUDE_PLUGIN_ROOT}`), so the
plugin default path is satisfied.

**Failure scenario to watch:** If a future change strips `CLAUDE_PLUGIN_DATA` from
the helper-runtime environment, the helper falls back to the stale Tier-3 HOME token.
This produces an authentication failure (HTTP 401), which surfaces as an explicit MCP
connection failure — **fail-closed, not silent**. No tool calls proceed on a 401.
