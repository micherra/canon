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
   header from the `headers` object.
2. Restart Claude Code with `--mcp-config /tmp/canon-http-scratch.mcp.json`.
3. Call `list_principles` or `init_workspace` as in Step 7.

**Expected result:** The tool succeeds and workspace writes land in the Canon repo
directory (the client's working directory at session start). The daemon answered
`roots/list` with the client cwd as a `file://` URI and resolved scope from it.

**If tools fail with a scope-unresolved error:** Add `"x-canon-project-dir":
"<absolute path to canon repo>"` to the `headers` object in your `.mcp.json` and
retry. File this finding — it means Claude Code's interactive HTTP client does not
answer `roots/list` in this version, and decision http2-03's primary path for
Phase 3 needs updating.

> **Note:** The headless client (`claude -p`, `--strict-mcp-config`) DOES answer
> `roots/list` as validated by PROBE-FINDINGS.md (2026-06-06, SDK 2.1.167). The
> interactive client's behavior is the residual risk confirmed at this gate.

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

## Summary of expected outcomes

| Check | Expected |
|-------|----------|
| `/health` endpoint | `{"ok":true,"port":3142,"transport":"http","version":"2.6.0"}` |
| Tools available in session | 42+ tools from `canon-http` server |
| `list_principles` | Returns principle list, no error |
| `init_workspace` writes | Land in current repo's `.canon/workspaces/` |
| `roots/list` Path B | Scope resolves without `x-canon-project-dir` header (if supported) |
| Cleanup | Daemon stopped, PID file removed, scratch config deleted |
