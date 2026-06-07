# app/mcp-http/

Stateful HTTP MCP transport subsystem: token-based auth, per-session McpServer registry, scope handshake, and idle-session eviction. Flag-dark (`CANON_HTTP_DAEMON=1`) until Phase 3.

See `.claude/CLAUDE.md` for auth contracts, session-manager invariants, and teardown order.
