---
adr: "0043"
title: "Fail-closed write-receipt completion gate (RCA Option C)"
status: accepted
date: "2026-07-06"
build: "design-spike-fail-closed-logstepcompleted-write-receipt-gate-so-an"
---

# ADR-0043: Fail-closed write-receipt completion gate (RCA Option C)

## Context

`enforceArtifacts` (the existing `log_step`/`batch_log_steps` completion gate) only rejects a
`status:"completed"` step when `artifacts_expected` is explicitly declared AND missing on disk.
When the orchestrator omits `artifacts_expected` — the exact failure mode this build targets — the
gate is a structural no-op: a step can be marked `completed` having produced nothing at all.

This build closes that gap with a durable **write receipt**: each of the six artifact-producing
agents (engineer, reviewer, tester, architect, scribe, security) now writes its mandatory artifact
through a dedicated MCP tool that emits a `write_receipt` event to the workspace's execution-store
event log immediately after a successful file write. `log_step`/`batch_log_steps` reject a
`status:"completed"` for a mapped `agent_type` unless a receipt (or, failing that, a real
non-skeleton file on disk) proves the artifact exists — independent of whether the orchestrator
remembered to declare `artifacts_expected`.

Full design: `plans/design-spike-fail-closed-logstepcompleted-write-receipt-gate-so-an/DESIGN.md`.
Probe findings (seam location, event-log API, tool-registration mechanism): same directory,
`PROBE-FINDINGS.md`.

## Options Considered

### Option A: Two-proof-tier split (receipt for tool-mediated agents, disk-only for the rest)

**Pros:**
- No new write tools needed for architect/scribe/security — smaller build.

**Cons:**
- Leaves 3 of 6 agents (architect DESIGN.md, scribe CONTEXT-SYNC.md, security SECURITY.md) with
  a hand-forgeable disk-only proof — the exact gap Option C exists to close, just narrowed to half
  the agent roster instead of all of it.

**Canon-principle alignment:** tensions `fail-closed-by-default` — a genuine artifact-production
proof beats a disk-existence check for 3 of 6 agents but not all 6.

### Option B: Receipt-only, no WR-02 disk-existence fallback

**Pros:**
- Fully closes the forge gap — a completion with no receipt is always rejected, even if a file
  happens to exist at the canonical path.

**Cons:**
- With no runtime kill-switch (enforce-always, no env/mode knob — see Decision below), a genuine
  lost receipt-emit (network hiccup, disk-full, a future bug) permanently blocks a legitimately-
  produced completion with no operational escape besides revert/redeploy.

**Canon-principle alignment:** tensions `observable-best-effort` — receipt emission is documented
as fail-open (never breaks the artifact write), so treating an emit failure as authoritative for a
downstream gate check contradicts that contract.

### Option C (chosen): All-six receipt-backed agents + WR-02 disk-existence fallback

**Pros:**
- Closes the bare-idle failure mode (no file AND no receipt) for all six agents, not a subset.
- WR-02 (fallback to a real, non-skeleton canonical file) makes a false-close of a genuine
  completion structurally near-impossible — the exact property `fail-closed-by-default` requires
  without introducing a new availability hazard.
- `write_receipt_weak_pass` telemetry makes every WR-02 file-branch pass observable, so a
  systemic raw-`Write` regression (an agent bypassing its granted tool) is detectable in the event
  log rather than silently normalized.

**Cons:**
- Three new dedicated write tools (`write_design`, `write_context_sync`,
  `write_security_assessment`) plus three agent-body retrainings — larger build than Option A.
- WR-02 narrows but does not eliminate the forge gap: a stale/hand-forged file at the canonical
  path with no receipt still passes (see Forge-Gap Residual Risk in DESIGN.md).

**Canon-principle alignment:** honors `fail-closed-by-default` (the bare-idle case is always
rejected) and `observable-best-effort` (receipt emission and weak-pass telemetry both stay
fail-open; no gate depends on an emit succeeding).

## Decision

Chosen: **Option C — all-six receipt-backed agents, WR-02 disk-existence fallback retained as
belt-and-suspenders.**

The bare-idle failure mode (no file, no receipt) is the RCA's actual target and is fully closed for
every mandatory-artifact agent_type. WR-02 is kept (not dropped, per Decision WR-07 in DESIGN.md)
because the build's own scope change — enforce-always, no runtime mode knob — makes an
unrecoverable false-close a real availability hazard; WR-02 makes that false-close structurally
near-impossible for any completion that produced its artifact, at the cost of a narrow,
telemetry-visible forge-gap residual.

## Canon-Principle Alignment

| Principle | Honors / Tensions | Notes |
|-----------|-------------------|-------|
| `fail-closed-by-default` | honors | A genuine no-receipt-and-no-file completion is rejected, armed from first deploy — no observe mode, no env-gated rollout. |
| `observable-best-effort` | honors | Receipt emission and `write_receipt_weak_pass` telemetry are both fail-open; the gate itself fails OPEN on its own infra error (`getEvents` throwing), which is the deliberate mirror-image posture — the checked *condition* fails closed, the gate's *own* infrastructure failure fails open. |
| `validate-at-trust-boundaries` | honors | Validation happens at both boundaries: `log_step`/`batch_log_steps` (every completion) and each write tool (the artifact-production boundary itself). |
| `no-llm-calls-in-mcp-tools` | honors | The gate is pure event-query + disk-scan; no model call anywhere in `enforceWriteReceipt`. |
| `simplicity-first` | tensions (acknowledged) | Three new write tools + a second completion gate is real surface area. Accepted because the alternative (Option A) leaves half the agent roster on a strictly weaker disk-only proof. |

## Consequences

**Positive:**
- A step can no longer be marked `completed` for a mandatory-artifact agent_type having produced
  literally nothing — the RCA's target failure mode is closed for all six agents.
- The `agent_type -> required-artifact` map and the exempt-step-pattern allowlist are now
  first-class, greppable, parity-tested artifacts (`mandatory-artifact-map.ts`,
  `exempt-step-patterns.ts`/`.txt`) — no more implicit, undocumented completion semantics.
- `write_receipt_weak_pass` telemetry gives the learner a durable signal for detecting a future
  raw-`Write` regression (an agent silently reverting to bypassing its granted write tool).

**Negative / trade-offs:**
- No runtime kill-switch. A bug in `enforceWriteReceipt` itself has no operational escape besides
  revert-and-redeploy — accepted because WR-02 makes a genuine-completion false-close structurally
  near-impossible, and the gate's own fail-open-on-infra-error carve-out covers a corrupt/unavailable
  store.
- The forge gap is narrowed, not eliminated: a completed step whose canonical file exists but was
  never receipted (lost emit, or a future raw-`Write` regression) still passes via WR-02. Mitigated
  by (a) the skeleton-marker tightening rejecting a partial/`IN_PROGRESS` file even with no receipt,
  and (b) `write_receipt_weak_pass` telemetry making every such pass visible.
- `orchestration-journal.ts` (an impact-63 hub) gained two call sites (`logStep`,
  `processEntries`) — kept to ~6 lines total by isolating all gate logic in `write-receipt.ts`.

## Revisit-If

- `write_receipt_weak_pass` telemetry shows a sustained, non-trivial rate of file-branch passes for
  a specific agent_type — that agent is very likely bypassing its granted write tool (a wiring
  regression), and the parity test (`agent-tool-wiring.test.ts`) plus a reviewer grep should catch
  it, but a persistent pattern in production telemetry means the wiring itself needs re-auditing.
- A real incident occurs where a lost receipt-emit (not a wiring bug) blocks a legitimate
  completion with no available recovery path other than revert/redeploy — that would be the
  concrete trigger for reconsidering the no-runtime-kill-switch posture (Decision WR-05/WR-07).
