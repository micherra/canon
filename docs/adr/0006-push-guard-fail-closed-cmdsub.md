---
adr: "0006"
title: "Push-guard uses fail-closed command-substitution span predicate instead of transparent-exec denylist"
status: accepted
date: "2026-06-12"
build: "address-pr-386-codex-p1-push-guard-bypass-resolve-merge-conflicts-with"
---

# ADR-0006: Push-guard uses fail-closed command-substitution span predicate instead of transparent-exec denylist

## Context

`hooks/push-to-main-guard.sh` must block attempts to sneak `git push` through shell
wrappers. PR #386 identified that the V1 approach — a denylist of known transparent-exec
wrappers (env, command, exec, nice, timeout, stdbuf, nohup, and their stacked forms) —
was bypassable by any wrapper that was not on the list.

Confirmed bypass classes in V1:
- `nohup $(echo git) push origin main` — nohup not in denylist when cmd-sub used
- `time $(echo git) push origin main` — shell built-in, transparent to the unwrap loop
- `setsid $(echo git) push origin main` — not enumerated
- `ionice / taskset / chrt / unbuffer / doas` — not enumerated
- `env -i $(echo git) push origin main` — env was handled for `env git` but not `env -i $(...)` form

Any denylist approach has the same structural defect: an adversary can choose an
unrecognized wrapper, and the list will always be incomplete.

The fix requires a durable property that holds regardless of the wrapper — one that
does not require enumerating wrapper names.

Key constraint: `canon_tokenize` (the project's quote-aware tokenizer) correctly handles
basic quoting but splits multi-word command substitutions across tokens by whitespace.
For example, `$(echo git)` becomes two tokens: `$(echo` and `git)`. Any span predicate
must account for multi-token substitutions.

A second constraint comes from PR #386 itself: worktree `node_modules` is now created via a
gitignored TypeScript `symlinkSync` call, not via `ln -s "$(realpath …)"` in shell. The V2
design intentionally accepts `ln -s "$(realpath x)" dest` as a BLOCK case (a sacrificed false
positive) because the workaround is already in place and the fail-closed guarantee is more
valuable than this rare shell form.

## Options Considered

### Option A: Extend the denylist

Add setsid, ionice, taskset, chrt, unbuffer, doas, env -i, and other known wrappers to the
V1 list and add tests for each.

**Pros:**
- Minimal change to existing logic
- Easy to reason about locally (each entry is explicit)

**Cons:**
- Structurally incomplete: any unlisted wrapper bypasses the guard
- Arms race: adversary adds `strace`, `perf`, `capsh`, `su -c`, `sudo sh -c`, etc.
- Maintenance burden grows with every new wrapper class discovered
- Fails the "surprising-without-context" condition in one direction — future contributors
  will not know why specific items are or are not listed

**Canon-principle alignment:** tensions `fail-closed-on-ambiguity` (dc-05) — the guard is
not closed; it is merely longer.

### Option B: Fail-closed span predicate (V2)

Block iff any clause of the command contains a command-substitution span (`$(…)` or `` `…` ``)
that is followed by at least one further non-punctuation token in the same clause. A
substitution in clause-final position is inert (argument-position data) and is allowed.

**Pros:**
- Closes the entire class without enumeration: any wrapper that uses `$(cmd)` to
  produce the `git` token will have further tokens after the substitution close, and
  will be blocked
- Deterministic: every form is statically classified without runtime evaluation
- Fail-closed (dc-05): any form that cannot be proven safe is blocked
- Acceptable false-positive rate: clause-final substitutions (`ls $(pwd)`, `echo $(date)`)
  are allowed; non-final substitutions that produce arguments (`ln -s "$(realpath x)" dest`)
  are blocked

**Cons:**
- `ln -s "$(realpath x)" dest` is now a BLOCK case. This is a sacrificed FP —
  acceptable because the Canon worktree symlink is performed via TypeScript `symlinkSync`,
  not via this shell form.
- Multi-token substitution tracking is non-trivial: `$(echo git)` tokenizes as `$(echo`
  and `git)`, so the predicate must track parenthesis balance across token boundaries.
- `< <(…)` process substitution silently produces no output inside nested bash functions
  under `set -euo pipefail`; the implementation must use here-strings with pre-computed
  variables instead.

**Canon-principle alignment:** honors `fail-closed-on-ambiguity` (dc-05) and
`errors-are-values` by making the block reason explicit in stderr output.

## Decision

Chosen: **Option B — Fail-closed span predicate (V2)**

The denylist approach is structurally incomplete regardless of how many entries it
contains; only a predicate that reasons about the syntactic structure of the substitution
itself can be closed. V2 achieves this by blocking any non-final command substitution
and accepting the sacrificed FP on `ln -s "$(realpath x)" dest`, which is already
handled via a TypeScript workaround.

## Canon-Principle Alignment

| Principle | Honors / Tensions | Notes |
|-----------|-------------------|-------|
| `fail-closed-on-ambiguity` (dc-05) | honors | Any form that cannot be statically proven safe is blocked |
| `errors-are-values` | honors | Block reason is emitted to stderr with an explicit message citing DEC-386-guard-v2-fail-closed-span |
| `probe-before-build-invoke-not-infer` | honors | Process-substitution `< <(…)` failure discovered empirically during implementation; fixed to here-string pattern |
| simplicity-first | tensions (acceptable) | Span predicate adds ~60 lines of bash; denylist extension would be ~10 lines but structurally broken |

## Consequences

**Positive:**
- Closes the entire cmd-sub wrapper bypass class without enumeration
- 169 tests pass (including all new V2 corpus cases)
- Future wrappers (capsh, strace, perf, etc.) are blocked automatically
- Guard behavior is self-documenting: the block message names the structural reason

**Negative / trade-offs:**
- `ln -s "$(realpath x)" dest` is now a BLOCK case. Shell scripts that build symlinks
  using `realpath` in that position must either rewrite the form or perform the operation
  outside the hook's scope (e.g., in TypeScript, Python, or as a separate non-interactive
  shell script)
- The predicate is ~60 lines of bash with balance-tracking logic; this is more complex
  than the denylist but is well-tested (169 cases)
- `< <(cmd)` process substitution is fragile inside nested bash functions under
  `set -euo pipefail`; here-string + pre-computed variable is the required pattern

## Revisit-If

- A clause-final substitution form that is semantically non-final is discovered in
  production use (e.g., `git push $(get_remote) $(get_branch)` — both substitutions are
  non-final and would be blocked, which is correct for this guard)
- Canon's worktree symlink is moved back to shell (e.g., the TypeScript symlinkSync is
  removed); in that case the sacrificed FP must be addressed
- A proof-of-concept bypass of the V2 span predicate is demonstrated
