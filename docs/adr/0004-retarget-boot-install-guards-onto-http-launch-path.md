---
adr: "0004"
title: "Retarget the boot-resolver + install-sim CI guards onto the HTTP launch path instead of deleting them"
status: accepted
date: "2026-06-11"
build: "adapt-install-sim-boot-resolver-ci-guards-for-the-http-mcpjson"
---

# ADR-0004: Retarget the boot-resolver + install-sim CI guards onto the HTTP launch path

## Context

PR #382 flipped the default `.mcp.json` `canon` server from the stdio
`command`/`args`/`env` form to `type:http` / `url` / `headersHelper`. Two CI guards are
structurally coupled to the stdio form and broke as a direct result:

- `mcp-server/mcp-json-resolver.test.sh` parsed `mcpServers.canon.args[1]` (the boot.sh
  `-c` locator payload) — now crashes with `TypeError: Cannot read properties of undefined`.
  It was the #356/#370 var-absent boot-regression guard.
- `scripts/install-sim-smoke.mjs` parsed `command`/`args` and spawned the launcher over the
  MCP SDK `StdioClientTransport` — now `command` is `undefined`. Its entire model
  (spawn the stdio command, handshake over stdio) does not apply to an HTTP transport.

These two guards encode three high-stakes boot/install regression classes:
- **#356** — Claude Code does not expand `${...}` in `.mcp.json` → the config silently
  collapsed to a literal `/mcp-server/boot.sh` path → `-32000`.
- **#361** — the ambient Node version differs from the repo-pinned version → asdf/mise shim
  exit 126.
- **#370** — a var-absent / broken install collapses silently to `-32000` instead of failing
  loud.

The transport changed exactly where these guards live. A separate Codex P2 review comment is
also valid: the flipped `url` hardcodes port `3142`, but the daemon + SessionStart supervisor
honor `CANON_DAEMON_PORT`, so a non-default port leaves every MCP connection pointed at 3142.

A throwaway empirical probe (committed to the build workspace `PROBE-FINDINGS.md`) drove a
real `claude -p --strict-mcp-config` client against a real daemon on a non-default test port and
established: CC DOES expand `${...}` in both `url` and `headersHelper`; the hardcoded-port form
genuinely fails to connect; and an unresolved `headersHelper` (helper-not-found → absent
`Authorization`) is a clean, catchable failure — the direct HTTP analog of #356.

## Options Considered

### Option A: Delete / skip the two failing guards to make CI green

**Pros:**
- Trivial; CI goes green immediately.

**Cons:**
- Removes the #356/#361/#370 boot-regression backstop at the exact moment the transport
  changed — the highest-risk possible time to lose it.
- A future regression in the HTTP launch path would ship undetected.

**Canon-principle alignment:** Directly violates `never-weaken-a-guard` (and the project rule
`never-override-linter-to-fit-change` in spirit). Rejected.

### Option B: Pin the guards to the (now non-default) stdio form

**Pros:**
- The existing guard code keeps working unchanged.

**Cons:**
- The default transport is HTTP now; a guard that only exercises a non-default stdio path is no
  longer faithful to a real install. It would pass while a real (HTTP) install is broken.

**Canon-principle alignment:** Tensions install-fidelity; a green guard that doesn't reflect the
shipped transport is worse than no guard. Rejected.

### Option C: Retarget both guards onto the HTTP launch path, preserving each regression class

**Pros:**
- Each regression class keeps a guard, migrated 1:1 onto the path that actually exists now:
  #356 → `headersHelper`/`url` `${...}` resolution (probe-confirmed); #361 → the
  `checkNodeVersion()` + 24.x CI Node, exercised through `boot.sh --daemon`; #370 → loud-fail on
  an unresolvable helper / missing `daemon.ts`. The Codex P2 port bug gains a static guard.
- The install-sim harness still boots faithfully (non-repo cwd, throwaway token, ambient-node
  path) and now connects via `StreamableHTTPClientTransport`.

**Cons:**
- More work than deletion; the install-sim harness gains daemon-lifecycle code (mitigated by
  module extraction to keep the file under the 600-line limit).

**Canon-principle alignment:** Honors `never-weaken-a-guard`, `fail-closed-by-default`,
`probe-before-build-invoke-not-infer`. Chosen.

## Decision

Chosen: **Option C — retarget both guards onto the HTTP launch path.**

The guards are migrated, not deleted: a documented old→new coverage map (in the build DESIGN.md
and as in-file rationale comments) records how each stdio regression class maps onto the HTTP
launch path. The `.mcp.json` `url` honors `CANON_DAEMON_PORT` via `${CANON_DAEMON_PORT:-3142}`.

## Canon-Principle Alignment

| Principle | Honors / Tensions | Notes |
|-----------|-------------------|-------|
| never-weaken-a-guard | honors | #356/#361/#370 coverage migrates onto the HTTP path with a documented 1:1 mapping; no class is dropped. |
| fail-closed-by-default | honors | Retargeted boot-resolver asserts loud-fail on an unresolvable helper / missing daemon entry; the auth helper already exits non-zero with no header on token failure. |
| probe-before-build-invoke-not-infer | honors | The load-bearing `${...}`-expansion behavior was resolved by invoking a real CC client + daemon, not inferred. |
| secrets-never-in-code | honors | The harness uses a throwaway token in a temp file; loopback only; never touches the real token. |

**Tension acknowledged:** the `.mcp.json` `headersHelper` relies on CC's *undocumented* `${...}`
expansion in that field (the docs list only `command`/`args`/`env`/`url`/`headers`). This is
accepted because it is the shipped behavior (PR #382), it is empirically verified, and the new
guard pins it — converting an invisible dependency into a tested one.

## Consequences

**Positive:**
- The boot/install regression backstop survives the transport flip; future HTTP-launch
  regressions are caught in CI.
- The `url` now tracks `CANON_DAEMON_PORT`, fixing the Codex P2 non-default-port failure.
- The retarget mapping is durable (this ADR + in-file comments), so a future contributor reading
  HTTP-shaped assertions in a file historically named for "boot-resolver var-absent" understands
  the lineage.

**Negative / trade-offs:**
- The install-sim harness now owns daemon lifecycle (spawn/health-poll/teardown), adding code
  that must be kept under the 600-line file limit via module extraction.
- The guards now depend on CC's `headersHelper` `${...}` expansion remaining stable (the
  revisit-if below covers this).

## Revisit-If

- A future Claude Code version stops expanding `${...}` in `url` or `headersHelper` (the guards
  themselves would catch this as a connection failure — at which point the auth/transport model,
  not the guard, needs redesign).
- The daemon launch command or the auth-via-helper model changes (the boot-resolver assertions
  would need re-pointing).
- CI can no longer run a background daemon, forcing the install-sim daemon-start out of the
  harness and into the workflow.
