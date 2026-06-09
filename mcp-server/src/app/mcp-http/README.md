# app/mcp-http/

Stateful HTTP MCP transport subsystem: token-based auth, per-session McpServer registry, scope handshake, and idle-session eviction. Flag-dark (`CANON_HTTP_DAEMON=1`) until Phase 3.

Also contains `loopback-host.ts` — shared DNS-rebinding guard (loopback allowlist + `isLoopbackHostRequest`) consumed by auth, daemon, and the sidecar HTTP server.

See `.claude/CLAUDE.md` for auth contracts, session-manager invariants, and teardown order.
