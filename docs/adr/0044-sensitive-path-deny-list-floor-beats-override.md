---
adr: "0044"
title: "Sensitive-path deny-list floors autonomy tier to supervised, beating override_tier"
status: accepted
date: "2026-07-10"
build: "add-a-sensitive-path-deny-list-floor-to-computeautonomytier-that-forces"
---

# ADR-0044: Sensitive-path deny-list floors autonomy tier to supervised, beating override_tier

## Context

`compute_autonomy_tier` assigns `autonomous` / `light-touch` / `supervised` from statistical/historical
signals (build history, blast radius, compliance). Higher tiers legitimately trade away HITL supervision.
But the tier is computed from *what has happened*, not *what the diff actually touches*. A build editing
Canon's safety hooks, CI, secrets, auth, drift-store schema, or public MCP tool contracts could be assigned
`autonomous`/`light-touch` — or forced there via `override_tier` — skipping the human + security review that
security-critical code most needs. Live dogfood: this very build's file set scored `light-touch`.

A narrow path floor already existed (`SECURITY_PATTERNS` → `has_security_files` → supervised) but
`computeConfidence` evaluated `override_tier` FIRST, so `override_tier` beat the floor, and the floor
surfaced no machine-readable signal and mandated no security/adversarial review. This ADR records the
consequential policy decision inside the generalization: **the deny-list floor beats `override_tier`.**

Recommendation H1 from the PostHog "code review tips" review; StampHog (PostHog's PR-approval agent) floors
sensitive path categories to escalation. Related in-tree rule: the security-intent row mandating a fresh
non-author adversarial agent after a CRITICAL/BLOCKING safety-hook fix — the floor generalizes it to a
path-driven, tier-computation-time invariant.

## Options Considered

### Option A: Floor beats `override_tier` (CHOSEN)

The sensitive-path floor is a safety invariant evaluated before the `override_tier` short-circuit; a caller
passing `override_tier: "autonomous"` on a sensitive-path diff still gets `supervised`.

**Pros:**
- Closes the exact bypass: no user or mis-computation can skip human + security review of the highest-risk code.
- Deterministic, testable, uncircumventable — matches Canon's "deterministic gates run in every tier" posture.

**Cons:**
- Contradicts the literal `override_tier` description ("Force a specific tier regardless of signals") — an
  explicit `autonomous` override is silently denied on sensitive paths.
- A power user who genuinely wants less supervision on a sensitive path has no escape hatch (by design).

**Canon-principle alignment:** honors `fail-closed-by-default`, `validate-at-trust-boundaries`; deliberately
tensions the `override_tier` user-control contract.

### Option B: `override_tier` remains absolute; floor only applies when no override is passed

The floor stays subordinate — an explicit override wins even on sensitive paths (today's behavior, made explicit).

**Pros:**
- Preserves the literal override contract; a user can always force a tier.

**Cons:**
- Leaves the bypass wide open — the one code path where risk-tiering can silently remove the checkpoints that
  matter most stays open. A single `override_tier: "autonomous"` skips security review on an auth/secrets diff.

**Canon-principle alignment:** tensions `fail-closed-by-default` — a safety gate a caller can wave off is not a floor.

## Decision

Chosen: **Option A — the deny-list floor beats `override_tier`.**

A floor that a preference can override is not a floor. `override_tier` is a preference over *statistical
signals*; the sensitive-path floor is a *safety invariant*. Safety invariants outrank preferences. Non-sensitive
diffs continue to honor `override_tier` unchanged, so the override contract is preserved everywhere it is not a
safety hazard. The floor never lowers a tier — it only ever raises the effective tier to `supervised`.

## Canon-Principle Alignment

| Principle | Honors / Tensions | Notes |
|-----------|-------------------|-------|
| fail-closed-by-default | honors | Floor evaluated from pure `file_paths` even when signal-gathering throws; never waved off by override. |
| validate-at-trust-boundaries | honors | `compute_autonomy_tier` is the boundary where autonomy is decided; the floor is the hard validation there. |
| errors-are-values | honors | No new throws; floor is data (`floor_engaged`/`require_*`) on the `ToolResult`. |
| (override_tier contract) | tensions | Explicit `autonomous`/`light-touch` override is denied on sensitive paths — accepted; safety beats preference. |

## Consequences

**Positive:**
- The highest-risk diffs always get human + `canon:security` + adversarial re-review; no silent bypass remains.
- Machine-readable `require_security`/`require_adversarial` fields let the orchestrator enforce the consequence deterministically.

**Negative / trade-offs:**
- `override_tier` is no longer absolute; docs must teach the exception or contributors will be surprised (mitigated by CLAUDE.md prose + this ADR).
- The deny-list is now a security-relevant surface; over-inclusion adds supervision cost, under-inclusion re-opens risk. It is itself on the deny-list (`mcp-server/src/features/orchestration/...` is `mcp-tool-contract`-adjacent) so edits to it are supervised.

## Revisit-If

- A legitimate, audited need arises to run a sensitive-path build unsupervised (e.g. a trusted automated migration) — then add a narrow, logged, per-category escape hatch rather than making the floor subordinate again.
- The deny-list produces frequent false-positive floors that materially slow low-risk builds — tighten patterns, do not weaken precedence.
