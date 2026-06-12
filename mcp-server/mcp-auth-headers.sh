#!/usr/bin/env bash
# mcp-auth-headers.sh — headersHelper for .mcp.json HTTP transport.
#
# Claude Code runs this script fresh per MCP connection and merges its JSON
# stdout into the request headers. On success, emits exactly:
#   {"Authorization":"Bearer <token>"}
# On failure (absent, empty, or unreadable token), emits NOTHING to stdout and
# exits non-zero so the connection fails honestly (fail-closed-by-default).
#
# Token path resolution mirrors auth.ts resolveTokenPath — three tiers:
#   1. $CANON_MCP_TOKEN_FILE   — explicit override
#   2. $CLAUDE_PLUGIN_DATA/canon-mcp-token
#   3. $HOME/.claude/canon/canon-mcp-token

set -euo pipefail

# ---------------------------------------------------------------------------
# Resolve token path (mirrors auth.ts resolveTokenPath exactly)
# ---------------------------------------------------------------------------
if [[ -n "${CANON_MCP_TOKEN_FILE:-}" ]]; then
  TOKEN_PATH="$CANON_MCP_TOKEN_FILE"
elif [[ -n "${CLAUDE_PLUGIN_DATA:-}" ]]; then
  TOKEN_PATH="${CLAUDE_PLUGIN_DATA}/canon-mcp-token"
else
  TOKEN_PATH="${HOME}/.claude/canon/canon-mcp-token"
fi

# ---------------------------------------------------------------------------
# Read and validate the token (secrets-never-in-code: never echo token to stderr)
# ---------------------------------------------------------------------------
if [[ ! -f "$TOKEN_PATH" ]]; then
  printf 'Canon MCP ERROR: token file not found: %s\n' "$TOKEN_PATH" >&2
  exit 1
fi

TOKEN=$(tr -d '[:space:]' < "$TOKEN_PATH")

if [[ -z "$TOKEN" ]]; then
  printf 'Canon MCP ERROR: token file is empty or whitespace: %s\n' "$TOKEN_PATH" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Emit JSON header — stdout only, no trailing newline issues
# ---------------------------------------------------------------------------
printf '{"Authorization":"Bearer %s"}' "$TOKEN"
