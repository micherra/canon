---
adr: "0005"
title: "Worktree node_modules via gitignored symlink with containment gate (not npm-install, not NODE_PATH)"
status: accepted
date: "2026-06-11"
build: "worktree-dev-environment-fixes-symlink-mcp-servernodemodules-into"
---

# ADR-0005: Worktree node_modules via gitignored symlink with containment gate

## Context

`init_workspace` creates Canon build worktrees with a plain `git worktree add` and no
node_modules setup. The repo-root `node_modules` does not carry mcp-server's dependencies
(zod, vitest, node type declarations), so from a fresh worktree those imports do not resolve.
The agent `LSP` tool (shipped PR #366) therefore silently degrades to syntax-only in the exact
environment agents run in, and IntelliJ floods false-positive diagnostics on worktree files.

A live probe this session confirmed the failure and the fix: in a clean worktree, `hover`
returned `z.infer<any>` and zod/vitest/relative-`.ts` imports failed; after symlinking
`mcp-server/node_modules` into the worktree, `hover` resolved the full type and the diagnostic
flood collapsed to a single legitimate deprecation hint.

This decision is **surprising without context** because Canon was burned twice by symlinks:
the boot.sh node_modules symlink (PR #296, where ESM ignored NODE_PATH) and a circular
node_modules symlink that caused boot churn. A future contributor seeing "add a node_modules
symlink" would reasonably object on that history. This ADR records why this case is
categorically safe.

## Options Considered

### Option A: Symlink mcp-server/node_modules into the worktree (gitignored + containment gate)

**Pros:**
- Instant, zero disk, zero network. Probe-validated.
- The symlink lives entirely under `.canon/workspaces/**` — `git check-ignore` confirms it is
  gitignored, outside the publishable `mcp-server/` package. It structurally cannot enter the
  git archive or the npm package.
- A mechanical tripwire (Guard 3 in `scripts/install-sim-smoke.mjs`) asserts the simulated
  install tree contains NO node_modules symlink and NO `.canon/` content — so a leak fails CI.

**Cons:**
- A symlink is a self-inflict risk if teardown follows it into the real node_modules. Closed by
  Guard 1 (unlink-not-follow, verified by a regression test asserting the main tree survives).
- Requires the main checkout's `mcp-server/node_modules` to exist (true after `npm ci`).

**Canon-principle alignment:** honors `simplicity-first` and `fail-closed-by-default`.

### Option B: npm install / npm ci per worktree

**Pros:**
- No symlink artifact anywhere.

**Cons:**
- Seconds and hundreds of MB per build; network dependency; adds no safety the four guards do
  not already provide.

**Canon-principle alignment:** tensions `simplicity-first`.

### Option C: NODE_PATH pointing at the main node_modules

**Pros:**
- No filesystem artifact in the worktree.

**Cons:**
- ESM ignores NODE_PATH. This is the documented PR #296 lesson — it would silently not work for
  the ESM mcp-server.

**Canon-principle alignment:** rejected on factual grounds.

## Decision

Chosen: **Option A — gitignored symlink with a containment gate.**

The symlink is created best-effort after `git worktree add`, targeting the resolved main
`mcp-server/node_modules` (outside the worktree subtree, so non-circular). Containment is
guaranteed two ways: structurally (the symlink lives in gitignored `.canon/**`, never in the
packaged `mcp-server/` tree) and mechanically (the install-sim-smoke containment assertion fails
CI if a node_modules symlink or `.canon/` content ever appears in a simulated install).

## Canon-Principle Alignment

| Principle | Honors / Tensions | Notes |
|-----------|-------------------|-------|
| simplicity-first | honors | One symlink vs a per-build install step + failure mode. |
| fail-closed-by-default | honors | Guard 3 fails CI on any containment breach; Guard 1 makes teardown unlink-not-follow. |
| measure-before-optimizing | honors | The fix was validated by a live LSP probe, not assumed. |

## Consequences

**Positive:**
- The shipped `LSP` capability actually works in the worktrees where agents run.
- IntelliJ worktree false-positive noise is incidentally reduced.

**Negative / trade-offs:**
- Adds two teardown invariants (unlink-not-follow across `workspace-cleanup.ts` and `janitor.ts`)
  that future teardown edits must preserve — covered by a regression test.
- Couples worktree health to the main checkout having `mcp-server/node_modules` present.

## Revisit-If

- mcp-server migrates off ESM, making NODE_PATH viable (would remove the symlink entirely).
- The main checkout stops carrying `mcp-server/node_modules` at a stable resolved path.
- Guard 3 is ever proposed to be weakened to allow a symlink in the package tree — that would
  reopen the PR #296 / circular-symlink scar and must be rejected.
