---
id: fail-closed-scan-scope
title: A Fail-Closed Scan Must Be Scoped to Its Threat Model
severity: convention
portable: true
scope:
  layers:
    - hooks
    - infra
  file_patterns:
    - "hooks/**"
    - "scripts/**"
---

A PreToolUse hook or security guard that blocks on metacharacter patterns (command substitution, pipes, string-executing wrappers) MUST first confirm that the input is within its threat model before applying the fail-closed scan. The threat-model check must be the **first** decision in the pipeline — not a downstream branch reached after metacharacter evaluation begins.

Without this gate, a fail-closed scan becomes a false-positive generator: it will block inputs that share the syntactic pattern but are semantically outside the threat. A grep whose argument contains `$(`, a maintenance script piped through `head`, a Bash invocation that sets `-euo pipefail` — none of these are within a git-push guard's threat model, but all match metacharacter patterns and will be blocked unless the guard checks first.

**Canonical ordering:**

```
1. Check: is this input in my threat model? (e.g., does this command contain a git token?)
2. If NOT in threat model → exit 0 immediately (non-threat inputs are always safe to pass)
3. If IN threat model → apply the full metacharacter / structural fail-closed scan
```

Inverting this order — scanning metacharacters before confirming threat-model membership — makes the hook a false-positive generator for every command that shares the pattern syntactically but is outside the threat semantically.

## Rationale

This convention REFINES `fail-closed-by-default` (rule), not replaces it. The rule says: when a check fails, deny access. This convention adds scope precision: a fail-closed denial is correct only when the input is within the guard's scope. Denying inputs that are structurally outside the threat model is not "safer" — it breaks legitimate workflows and erodes agent trust in hooks.

**Evidence (2/2 hooks with the same failure shape):**

| Instance | Hook | False-positive pattern | Fix |
|----------|------|-----------------------|-----|
| 1 | `hooks/push-to-main-guard.sh` | Metacharacter scan ran before `canon_has_git_token` check — blocked `grep -n "pipe\|$(" /path`, `bash -c 'set -euo pipefail; ...'`, and others (~8 blocked commands over 3 sessions) | Gate scan behind `canon_has_git_token` — non-git commands exit 0 immediately (PR #386, commit `87dbbdc2`) |
| 2 | `hooks/destructive-guard.sh` | Fail-closed on non-destructive Bash commands in agent contexts — same root: scan fired before threat-model confirmation | Structurally identical gap; confirm-then-scan ordering applied |

The disguised-push vector is still caught after the fix: a recognized `bash -c` wrapper that DOES contain a git token still hits the post-unwrap guard. Threat-model scoping does not weaken the guard — it removes false positives while preserving true positive coverage.

## Examples

**Bad — metacharacter scan fires before threat-model confirmation:**

```bash
# push-to-main-guard.sh (BEFORE fix)
# The metacharacter scan runs on ALL commands, including non-git ones.
if contains_metachar "$command"; then  # fires on 'grep "pipe\|$(" /path' → false positive
  echo "CANON: blocked"
  exit 2
fi
if canon_has_git_token "$command"; then
  # ... git-push-specific checks
fi
```

**Good — threat-model check gates the scan:**

```bash
# push-to-main-guard.sh (AFTER fix, PR #386)
# Non-git commands exit 0 immediately — never reach the metacharacter scan.
if ! canon_has_git_token "$command"; then
  exit 0
fi
# Input is confirmed in-scope for this guard. Now apply the fail-closed scan.
if contains_metachar "$command"; then
  echo "CANON: blocked — disguised push attempt"
  exit 2
fi
```

**Good — scope check in a destructive-guard context:**

```bash
# destructive-guard.sh
# Confirm the command targets a destructive operation before blocking on wrappers.
if ! canon_is_destructive_op "$command"; then
  exit 0
fi
# In-scope: apply fail-closed wrapper/metachar scan.
```

## Relationship to Sibling Conventions

- **`fail-closed-by-default` (rule)**: The parent rule — when a check fails, deny. This convention adds: define the scope of the check before denying.
- **`hooks-fail-closed` (rule)**: Safety hooks must fail closed on extraction failure or missing tooling. Orthogonal: that rule covers the hook's own internal error handling; this convention covers what inputs the hook evaluates at all.
- **`scanner-avoids-its-own-pattern` (convention)**: A scanner must not contain the literal pattern it detects. Orthogonal: that convention addresses scanner self-contamination; this convention addresses scanner scope.

## Exceptions

A hook that is explicitly designed to run on ALL inputs (regardless of threat model) — such as a universal formatter or logger — is exempt from this convention. The convention applies specifically to guards whose fail-closed behavior is justified by a scoped threat model (e.g., "block disguised git pushes," "block destructive shell operations"). If a guard's scope is intentionally universal, document that intent in a comment.

## Anti-Rationalization

| Excuse | Why It's Wrong | Correct Action |
|--------|---------------|----------------|
| "Scanning all inputs is more conservative." | More conservative is not always more correct. A guard that fails on inputs outside its threat model is not safer — it is miscalibrated. False positives break legitimate workflows and accumulate agent friction. | Define the threat model. Gate the scan on confirmation. |
| "The false positives are rare." | Rare at first. Hooks run on every agent Bash command — across builds, sessions, and agent types, false-positive rate compounds. The push-to-main guard blocked ~8 legitimate commands over 3 sessions in a narrow window. | Apply the confirm-then-scan order from day one. |
| "The fix might introduce a bypass." | The confirm-then-scan fix does not weaken the guard — a disguised push that contains a git token is still caught by the post-confirmation scan. The bypass concern applies only if the threat-model check itself is too narrow. | Verify the threat-model check covers the known bypass vectors (e.g., `canon_has_git_token` checks for the token, not just the word "git"). |

## Verification

- [ ] Every PreToolUse hook that contains a fail-closed metacharacter or structural scan has a threat-model confirmation check at the start of its decision pipeline.
- [ ] The threat-model check exits 0 immediately for non-matching inputs — it does NOT fall through to the scan.
- [ ] The disguised-attack vectors covered by the scan are still covered after the threat-model gate is applied (no true-positive regression).

## Related

[[fail-closed-by-default]] — the parent rule this convention refines: fail-closed denial is correct policy; this convention adds that the scope of the check must be confirmed before denying. [[hooks-fail-closed]] — orthogonal companion rule covering internal hook error handling (extraction failure) rather than input scope; both govern correctness of the guard's decision.
