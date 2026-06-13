---
adr: "0014"
title: "Canon MCP auth token resolves to a single env-independent canonical path"
status: accepted
date: "2026-06-12"
build: "durable-fix-for-canon-mcp-clientdaemon-auth-token-path-nondeterminism"
---

# ADR-0014: Canon MCP auth token resolves to a single env-independent canonical path

## Context

The Canon HTTP MCP daemon (`mcp-server/src/app/mcp-http/auth.ts`, `resolveTokenPath`) and the client-side headers helper (`mcp-server/mcp-auth-headers.sh`) each independently implemented the same 3-tier token-path resolution:

1. `$CANON_MCP_TOKEN_FILE` — explicit override
2. `$CLAUDE_PLUGIN_DATA/canon-mcp-token`
3. `$HOME/.claude/canon/canon-mcp-token`

Because the two run as separate processes with different environments, they could resolve to different tiers. In a live incident (2026-06-12) the daemon ran WITH `CLAUDE_PLUGIN_DATA` (→ tier-2) while the Claude Code harness invoked the helper WITHOUT it (→ tier-3). The two token files held different secrets, so the helper sent a token the daemon rejected: HTTP 401 → `/mcp` reconnect failed with an opaque "auth fails", costing a full debugging session. It would recur on the next token regeneration.

This is an instance of the "two consumers of the same premise resolve differently" defect class (cf. ADR-0003 and the var-absent boot resolver in PR #370 / watch_HHHHHHHH1).

Empirical probing (`PROBE-FINDINGS.md`, round 2) established the load-bearing facts: (a) the helper's process environment cannot be relied on to carry `CLAUDE_PLUGIN_DATA` or `CLAUDE_PLUGIN_ROOT` — both are UNSET in the live harness-invoked process; (b) tier-2 was introduced in PR #342 as convenience with no documented isolation contract; (c) the daemon binds a single fixed port (3142), so only one daemon is ever active per machine and tier-2's per-install token isolation is unreachable at runtime.

## Options Considered

### Option A: Pin `CANON_MCP_TOKEN_FILE` (tier-1) on both sides

**Pros:**
- Keeps all three tiers; forces both processes to a known path.

**Cons:**
- Empirically infeasible: the headersHelper process has `CLAUDE_PLUGIN_DATA`/`CLAUDE_PLUGIN_ROOT` unset, and there is no evidence the harness propagates a `.mcp.json` `env` block to it. The daemon is launched by a separate process (the SessionStart supervisor hook), so the two pins could themselves drift — reproducing the exact fragility being removed.

**Canon-principle alignment:** tensions `simplicity-first`; does not actually satisfy the no-drift requirement.

### Option B: Daemon writes the token to all candidate paths at startup

**Pros:**
- Guarantees identical content across divergent readers.

**Cons:**
- Writes the secret to more filesystem locations (larger attack surface); a band-aid that leaves the "two resolvers can disagree" defect intact; stale copies linger.

**Canon-principle alignment:** tensions `minimize-attack-surface` and the `secrets-never-in-code` posture.

### Option C: Collapse to a single env-independent canonical path — drop tier-2

**Pros:**
- Both processes resolve from the one environment input they reliably share (`$HOME`); divergence becomes structurally impossible. Tier-1 explicit override retained. Smallest reachable attack surface (one token file). Tier-2 isolation is moot (single fixed port → single active daemon).

**Cons:**
- Removes a tier that superficially looks like multi-install isolation; one-time migration for installs whose only token lives at the tier-2 path (a fresh home token is created fail-closed on next boot).

**Canon-principle alignment:** honors `define-errors-out-of-existence`, `fail-closed-by-default`, `minimize-attack-surface`, `simplicity-first`, `information-hiding`.

## Decision

Chosen: **Option C — collapse to a single env-independent canonical path.**

`resolveTokenPath` becomes 2-tier: `CANON_MCP_TOKEN_FILE` → `$HOME/.claude/canon/canon-mcp-token`. The `$CLAUDE_PLUGIN_DATA` branch is deleted from both the TypeScript resolver and the shell helper. Because the two consumers now compute the identical path from `$HOME` alone, the env-divergence failure cannot occur. Tier-1 is retained as an intentional override for test injection and `install-sim-smoke`.

## Canon-Principle Alignment

| Principle | Honors / Tensions | Notes |
|-----------|-------------------|-------|
| define-errors-out-of-existence | honors | The 401-from-token-divergence error class is removed structurally, not patched. |
| fail-closed-by-default | honors | Absent/empty/unreadable token still fails honestly; only the resolution branch changed, not the failure path. |
| minimize-attack-surface | honors | One secret-bearing file instead of two candidate paths. |
| simplicity-first | honors | One resolution decision in one place; no cross-process env coordination. |
| secrets-never-in-code | honors | No token value in source, logs, or tests; preserved by the implementation. |

## Consequences

**Positive:**
- The daemon and helper provably resolve the same path/secret regardless of per-process env.
- A regression test reproduces the exact incident (helper with/without `CLAUDE_PLUGIN_DATA` → same token; authenticates against a daemon started in either env).

**Negative / trade-offs:**
- Installs whose only token currently lives at the `CLAUDE_PLUGIN_DATA` path will create a fresh home token on next daemon boot (the stale data-dir file is harmless and may be left or cleaned).
- If true multi-install concurrency is ever required, a new env-independent install-keyed scheme would be needed (see Revisit-If).

## Revisit-If

- The daemon gains per-install / per-port concurrency (multiple daemons on one machine) — per-install token isolation becomes reachable and a deterministic, helper-visible install key would be required (not `CLAUDE_PLUGIN_DATA`, which the helper cannot see).
- The Claude Code harness begins reliably propagating `CLAUDE_PLUGIN_DATA` or a documented `.mcp.json` `env` into the headersHelper process — a pin would then be viable, though the canonical path remains simpler.
