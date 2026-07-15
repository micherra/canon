---
adr: "0053"
title: "adr-number-check open-PR scan WARNs and fails OPEN — it never blocks a push on GitHub availability"
status: accepted
date: "2026-07-11"
build: "extend-hooksadr-number-checksh-to-detect-adr-number-collisions-against"
---

# ADR-0053: The concurrent-open-PR ADR-collision scan WARNs (exit 0) and fails OPEN on gh unavailability

## Context

`hooks/adr-number-check.sh` is a fail-closed PreToolUse `git push` gate. It blocks (exit 2) a push that
adds `docs/adr/NNNN-*.md` when that `NNNN` already exists on committed `origin/main` under a different
slug. It structurally cannot see a number claimed on **another still-open PR's branch** — neither branch
is on `main` yet, so both pass the gate and collide only when both merge (two `docs/adr/NNNN-*.md` with
different slugs, a silent duplicate ADR number).

This gap is real and recurrent (learner `watch_ZZZZZZZ1`, 16 instances; the M2 build renumbered
0045→0046→0047). It was live during this build: two open PRs (#491, #494) each add `docs/adr/0048-*.md`
with different slugs right now, forcing the orchestrator to hand-assign 0050/0051 to two concurrent
builds. The extension detects this by querying open PRs via `gh` at push time.

Adding a **network call to a safety gate that runs on every push** forces a decision the committed-main
check never had to make: what happens when the network is slow, offline, unauthenticated, or `gh` is
absent — and what happens when a concurrent claim IS found?

## Decision

The open-PR scan is **advisory and exit-0-only**. It has exactly two outcomes, both non-blocking:

1. **A concurrent open-PR claim is found → print `CANON WARNING` and `exit 0`** (WARN, not BLOCK).
2. **`gh` is absent / unauthenticated / offline / times out / returns non-zero / returns malformed
   output → silently `exit 0`** (fail OPEN).

No code path added by the scan may produce a non-zero exit. The pre-existing committed-main dimension is
untouched and remains **fail-CLOSED** (exit 2). The two dimensions in the same hook therefore have
deliberately opposite postures.

The scan is bounded by an injectable `timeout` (default 8s; measured normal latency ~0.3s) and is reached
only after the committed-main check passes for a push that actually adds an ADR — a rare event, so it does
not tax ordinary pushes.

## Rationale

**Why fail OPEN on gh unavailability.** A safety gate that blocks every offline, unauthenticated, or
slow-network push is worse than the gap it closes. Blocking the wire because GitHub is unreachable
punishes correct behavior on every disconnected developer. The network dimension is not a safety
invariant the gate can guarantee — it is best-effort signal, so it fails open. (Consistent with Canon's
existing advisory-gate carve-out from `hooks-fail-closed`: the evaluator gate and `daemon-version-nudge.sh`
also fail open because they are quality/advisory signals, not safety invariants.)

**Why WARN, not BLOCK, on a found collision.** The open-PR dimension is inherently racy and
eventually-consistent: an open PR's number can be abandoned (a PR that never merges), and the PR set can
change between the scan and the merge. BLOCKING would let a single stale/abandoned open PR permanently
wedge every legitimate push that reuses "its" number until manual intervention — an over-block. Crucially,
the committed-main check already guarantees no *merged* duplicate: whichever colliding PR merges first
puts `NNNN` on `origin/main`, and the second PR's push is then fail-CLOSED by the existing check. So the
hard-stop backstop is intact regardless; the scan only moves the warning EARLIER, letting the author
renumber proactively — automating exactly the manual coordination this build was created to remove.

**Why the exit-0-only invariant is stated explicitly.** It is the mechanically-checkable form of "never
over-block." A reviewer confirms one property — no non-zero exit anywhere in the added block — instead of
reasoning through each failure branch. It is also the property most likely to be silently broken by a
future well-intentioned "harden it to block" edit; naming it here is the guard.

## Alternatives Considered

- **BLOCK (fail-closed) on a concurrent-open claim.** Rejected: over-blocks on stale/abandoned open PRs
  and on gh-state races, with no safety gain over the committed-main backstop that already blocks a true
  merged duplicate.
- **Fail CLOSED on gh unavailability** (block the push when gh can't be reached). Rejected outright: this
  is the load-bearing anti-goal — it blocks every offline developer and is strictly worse than the gap.
- **Structural redesign** (lease files / timestamp-based ADR IDs to make numbers collision-free by
  construction). Deferred: larger change, out of scope; noted as a possible future direction.
- **Do nothing.** Rejected: the gap recurs every concurrent-ADR session (16 instances; twice this
  session), forcing manual number coordination and renumber churn.

## Consequences

- A developer pushing a second ADR that reuses an open PR's number is warned at push time and can
  renumber before merge, without any push ever being blocked by network state.
- A collision that is warned-but-ignored is still caught fail-CLOSED at the second merge by the
  committed-main check — no merged duplicate can slip through.
- Future edits must preserve the exit-0-only invariant for the open-PR block; a change that makes it block
  (on found-collision or on gh-unavailability) is a regression of the never-over-block property and must
  be re-argued against this ADR.
- The scan depends on `gh` + `jq` + `timeout`; any absent → the scan is a silent no-op (the committed-main
  check still runs). Test seams: `CANON_ADR_GH_BIN`, `CANON_ADR_OPENPR_TIMEOUT`, `CANON_ADR_OPENPR_LIMIT`.
