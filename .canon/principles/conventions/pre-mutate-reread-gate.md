---
id: pre-mutate-reread-gate
title: Pre-Mutate Re-Read Gate — Re-Read Authoritative State Before Any Mutating Step
severity: convention
portable: false
scope:
  layers: []
  file_patterns:
    - "hooks/**"
    - "CLAUDE.md"
    - "references/**"
    - "agents/**"
tags:
  - concurrency
  - git
  - orchestration
  - state-management
---

Before any state-mutating orchestration step — git commit, git merge, git push, ADR number assignment, `log_step`, or `write_orchestrator_checkpoint` — the orchestrator MUST re-read the current state from the authoritative source (filesystem, git, or journal) and verify it matches the snapshot from the last inspection. If the state has changed since the snapshot, abort the mutation and re-inspect before proceeding. Do not cache git status, HEAD SHA, or journal state across tool calls; treat each as a potentially stale read.

**Advisory hook:** `hooks/pre-mutate-reread.sh` emits a staleness signal (comparing `git status --porcelain` and `git log --oneline -1` against a `BOARD_LAST_READ` snapshot) before any mutating step. The hook exits 0 (advisory only) — the L1 protocol and the workspace mutex ([[workspace-mutex-exclusive-init]]) are the authoritative enforcement layers.

## Rationale

**The 2026-06-24 incident:** The orchestrator in session `72f2b372` read `UU CLAUDE.md` (unresolved conflict state) in the shared worktree during a git status inspection. Seconds later, peer session `6429ca3b` resolved the merge and committed (`16ff30da`, 2026-06-24 19:50:34). Any action taken on the stale snapshot — editing the conflict markers, proposing a resolution, or committing — would have operated on a file already committed clean. The same build also produced ADR-0021 number collision: both sessions scanned `origin/main:docs/adr/` at the same moment and assigned ADR-0021 to different records (Instance 13 of watch_ZZZZZZZ1). The shared scanning source was stale by the time either session committed.

The fundamental hazard is that inspection and mutation are not atomic. Any time elapsed between reading state and acting on it is a window for a peer to change that state. In a concurrent environment this window is not theoretical — the same ADR-collision class has now occurred 13 times (watch_ZZZZZZZ1). The fix is structural: re-read from the authoritative source immediately before each mutation, not at the start of the orchestration session.

## Three Specific Instances of the Rule

**1. Before `git merge` / `git commit` / `git push`:**

Re-run `git status --porcelain` and `git log --oneline -1`. Compare `HEAD` SHA to the snapshot from the last inspection. If HEAD has moved or the working tree state has changed, re-inspect before proceeding.

```bash
# Re-read immediately before committing:
CURRENT_HEAD=$(git -C "${WORKTREE}" rev-parse HEAD)
CURRENT_STATUS=$(git -C "${WORKTREE}" status --porcelain)
# Compare to snapshot from last inspection (LAST_HEAD, LAST_STATUS)
if [[ "$CURRENT_HEAD" != "$LAST_HEAD" || "$CURRENT_STATUS" != "$LAST_STATUS" ]]; then
  echo "State changed since last inspection. Re-inspect before proceeding."
  exit 1
fi
```

**2. Before ADR number assignment:**

Scan BOTH `origin/main:docs/adr/` AND all sibling `.canon/workspaces/*/worktree/docs/adr/` directories. `origin/main` alone is not sufficient — unshipped ADRs in peer worktrees are invisible to `origin/main` but occupy the same number namespace. The concurrent-unshipped window is real (Instance 13 of watch_ZZZZZZZ1).

```bash
# Correct: scan both remote and local worktrees
HIGHEST_REMOTE=$(git ls-tree origin/main:docs/adr/ 2>/dev/null \
  | grep -oP '(?<=NNNN-).*(?=\.md)' | sort -V | tail -1)
HIGHEST_LOCAL=$(find "$(git rev-parse --show-toplevel)/.canon/workspaces" \
  -path "*/worktree/docs/adr/*.md" 2>/dev/null \
  | grep -oP 'NNNN-' | sort -V | tail -1)
NEXT=$((max(HIGHEST_REMOTE, HIGHEST_LOCAL) + 1))

# Wrong: scan origin/main only — misses unshipped peer ADRs
NEXT=$(git ls-tree origin/main:docs/adr/ | ... | tail -1 | increment)
```

**3. Before `log_step` dispatching a new step:**

Call `reconcile_workspace` (already in the resume protocol) to verify the step is not already `started` or `completed` by a peer write. A peer orchestrator may have advanced the journal between the last `get_history` read and the current `log_step` call.

```
# Before dispatching a step:
reconcile_workspace({ workspace, emit_telemetry: true, source: "pre-dispatch" })
# If result shows the target step_id is already "started" or "completed" → surface to user, do not re-dispatch
```

## Examples

**Bad — stale git snapshot acted on without re-read:**

```
# Orchestrator reads git status at session start (19:45):
git status --porcelain → "UU CLAUDE.md"

# Peer session resolves conflict and commits at 19:50:
git commit -m "resolve CLAUDE.md conflict" (SHA: 16ff30da)

# Orchestrator (still using 19:45 snapshot) tries to resolve the conflict at 19:51:
# → operates on a file already committed clean
# → creates a new merge commit that RE-introduces the conflict markers
```

**Good — re-read immediately before mutation:**

```
# Orchestrator re-reads immediately before committing:
git status --porcelain → "" (clean — peer already resolved it)
git log --oneline -1   → "16ff30da resolve CLAUDE.md conflict"
# HEAD moved. Re-inspect. No action needed on CLAUDE.md.
```

**Bad — ADR number from origin/main only:**

```
# Session A: scans origin/main → highest ADR is 0020 → assigns 0021
# Session B (concurrent): scans origin/main → highest ADR is 0020 → also assigns 0021
# Both commit ADR-0021 to their respective worktrees.
# PR merge produces two ADR-0021.md files for different decisions.
```

**Good — ADR number includes sibling worktrees:**

```
# Session A: scans origin/main (0020) + sibling worktrees → finds nothing → assigns 0021
# Session B: scans origin/main (0020) + sibling worktrees → finds Session A's 0021 → assigns 0022
# No collision.
```

## Advisory Hook: `hooks/pre-mutate-reread.sh`

The hook is called by mutating steps (commit, merge, push) to emit a staleness signal. It compares the current `git status --porcelain` + `git log --oneline -1` output against a `BOARD_LAST_READ` environment variable snapshot. If the current state differs, it emits an advisory warning to stderr. The hook **exits 0** — it is a signal layer only. The L1 behavioral obligation (this convention) and the workspace mutex are the enforcement layers. The hook follows the advisory posture of the codex-defect advisory convention (watch_VVVVV3).

## Exceptions

- **Read-only steps** (research, observe, inspect, `get_history`, `get_context`) do not require a re-read gate. The gate applies only before state-mutating operations.
- **Learner** writes exclusively to `.canon/` (gitignored build state) — its operations do not compete with build orchestrators on tracked files. Exempt.
- **Hook itself:** `pre-mutate-reread.sh` reads state rather than mutating it — the re-read gate does not recurse into itself.

## Anti-Rationalization

| Excuse | Why It's Wrong | Correct Action |
|--------|---------------|----------------|
| "I read git status at the start of this step — that's recent enough." | 'Recent enough' is not a guarantee in a concurrent environment. The peer session committed `16ff30da` in the 6 seconds between the orchestrator's inspection and its commit attempt. | Re-read immediately before the mutation — not at step entry. |
| "The workspace mutex prevents concurrent sessions." | The mutex gates `init_workspace` / `finalize_workspace`, not every individual mutation. The mutex reduces the window; it does not eliminate per-operation races within the window of normal orchestration. | Use the re-read gate in addition to the mutex, not instead of it. |
| "Scanning sibling worktrees for ADR numbers is expensive." | The scan is one `find` call on local filesystem paths — sub-millisecond. The cost of an ADR collision (two decisions with the same number, manual rename PR) is hours. | Run the scan. It is cheap. |
| "The advisory hook emitting 0 means there's no enforcement." | Correct — the hook is a signal layer. Enforcement is behavioral (this convention) and structural (the workspace mutex). The hook makes violations visible in stderr. | Follow the convention; the hook catches violations that the convention missed. |

## Verification

```bash
# Confirm pre-mutate-reread.sh exists and exits 0:
bash hooks/pre-mutate-reread.sh && echo "exits 0 (advisory)"

# Check the hook is registered for mutating operations:
cat hooks/hooks.json | jq '.[] | select(.event | contains("PreToolUse"))'

# Confirm CLAUDE.md pre-mutate protocol section is present:
grep -n "Pre-Mutate Re-Read Gate\|pre-mutate" CLAUDE.md
```

## Related

- [[workspace-mutex-exclusive-init]] (OOOOOOOOOO4) — outer workspace guard; the mutex is the coarse guard; the re-read gate is the fine per-operation guard; both are required
- [[step-scoped-review-artifacts]] (OOOOOOOOOO1) — atomic pair write is the artifact-level analog of the same invariant (don't let consumers see half-written state)
- [[session-unique-agent-naming]] (OOOOOOOOOO2) — the naming convention prevents misrouting; the re-read gate prevents stale-state mutations; both address concurrent-session interference
- `disk-is-source-of-truth-on-resume` — the resume-time variant of this principle (re-read disk before re-doing unit work); the re-read gate is the pre-mutation variant
