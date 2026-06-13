---
id: hooks-observable-failures
title: Hook Failures Must Be Observable or Explicitly Justified
severity: convention
portable: false
scope:
  layers:
    - hooks
  file_patterns:
    - "hooks/**"
tags:
  - observability
  - hooks
  - debugging
---

In `hooks/**`, when an operation is intentionally best-effort and its failure is silently swallowed (`2>/dev/null`, `|| true`, empty catch), the swallow must be made observable or explicitly justified. For guard hooks, non-zero exit is the observable signal. For advisory hooks, a `CANON WARNING:` line on stderr is the minimum. A bare silent swallow with no comment and no output is flagged.

**Scope note:** This is the `hooks/**`-scoped sibling of `observable-best-effort`. See decision `quality-coverage-01`: `observable-best-effort` is promoted to `rule` severity and scoped to `mcp-server/src/**` via the project's principle-overrides. Extending it to hooks would mass-flip ~273 existing silent-swallow sites in that file pattern to BLOCKING — a violation of this build's no-flip constraint. This convention is `hooks/**`-only and kept at `convention` severity (advisory, not blocking) to preserve the scope boundary.

## Rationale

Hook scripts accumulate silent swallows for understandable reasons: a `|| true` prevents the script from aborting on a non-critical helper call; a `2>/dev/null` suppresses noisy output from a command that can legitimately fail. These suppressions are often correct. The problem is when they become invisible — when a hook's main detection logic breaks but the hook exits 0 and the user sees nothing.

Examples from the hooks layer before this program:

- Advisory hooks that called external tools (`git`, `sqlite3`) with `2>/dev/null || true` — if the tool was absent, the hook silently skipped its advisory output. No warning, no signal. The user believed the hook was running when it was not producing output because the hook had no work to do, not because the hook was broken.
- Guard hooks that used `|| true` on the extraction expression — this converted extraction failure into empty command, and the empty-command branch exited 0. The guard was silently disabled.

The fix is not to remove all `|| true` and `2>/dev/null` — that would break intentional suppression of noisy output. The fix is to keep a `CANON WARNING:` line for advisory failures and to ensure guard hooks distinguish extraction failure from genuine no-op.

**The three acceptable patterns for a silent swallow in `hooks/**`:**

1. **Non-zero exit (guard):** the operation's failure is the hook's block signal — no additional log needed.
2. **`CANON WARNING:` to stderr (advisory):** the operation failed but the hook is advisory-only; a warning makes the failure visible without blocking.
3. **Justifying comment:** a comment that names the specific reason the failure is unobservable and why it is genuinely uninteresting (e.g., `# jq unavailable; grep fallback already attempted above`).

A bare `2>/dev/null || true` or `|| true` with no comment and no warning output is the pattern flagged by this convention.

## Examples

**Bad — silent swallow, advisory hook, no warning output:**

```bash
# Advisory hook — emits a nudge if conditions are met.
COUNT=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM builds" 2>/dev/null || true)
if [[ "$COUNT" -gt 10 ]]; then
  echo "CANON: consider running learn step" >&2
fi
# If sqlite3 is absent: COUNT="", the if-branch is skipped, no output.
# User cannot tell whether the hook ran correctly or whether sqlite3 was missing.
```

**Good — advisory hook with observable failure:**

```bash
COUNT=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM builds" 2>/dev/null) || {
  echo "CANON WARNING: learn-nudge hook: sqlite3 query failed — nudge skipped." >&2
  exit 0
}
if [[ "$COUNT" -gt 10 ]]; then
  echo "CANON: consider running learn step" >&2
fi
```

**Good — justifying comment makes the swallow explicit:**

```bash
# Extract session count. Failure means no session data exists yet (first run).
# Silently default to 0 — count absence is not an error condition.
# shellcheck disable=SC2312
SESSION_COUNT=$(sqlite3 "$DB_PATH" "SELECT COUNT(*)" 2>/dev/null || true)
SESSION_COUNT="${SESSION_COUNT:-0}"
```

The comment names the specific reason (`count absence is not an error condition`) and the expected failure mode (`first run`). This is the "intentional bare swallow with comment" pattern — acceptable.

**Bad — guard hook with a silent swallow masking extraction failure (pre-fix):**

```bash
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null || true)
# If jq absent: COMMAND="" → exit 0 → guard silently disabled.
[[ -z "$COMMAND" ]] && exit 0
```

**Good — guard hook where the swallow is on a helper, and the guard's own path is observable:**

```bash
# canon_extract_command uses jq with grep/sed fallback; the || true is internal
# to the library and covers only the grep/sed pipe — documented in the library.
COMMAND=$(canon_extract_command "$INPUT")
if [[ -z "$COMMAND" ]]; then
  # Two-stage check per hooks-fail-closed rule.
  if printf '%s' "$INPUT" | grep -qE '"command"[[:space:]]*:[[:space:]]*"[^"]'; then
    echo "CANON: extraction failed — blocking fail-closed." >&2
    exit 2
  fi
  exit 0
fi
```

The `|| true` that exists inside `canon_extract_command` is justified by a comment in the library. The calling hook's own logic has no bare swallows.

## Exceptions

Cosmetic suppressions of well-understood noisy output where the failure has zero impact on hook correctness are acceptable. Examples:

- `git symbolic-ref --short HEAD 2>/dev/null || true` in a hook that treats an empty branch as a legitimate "not in a git repo" signal, with a comment documenting this intent.
- `command -v jq >/dev/null 2>&1` availability checks where the absence branch is explicit code, not fallthrough.

In these cases, the swallow is acceptable because the *calling code* handles the empty/absent result explicitly and the comment documents the intent.

**See also:** `observable-best-effort` (`strong-opinions/observable-best-effort.md`) — the project-wide principle (promoted to `rule` for `mcp-server/src/**`) from which this convention is derived. Do not modify `observable-best-effort` to include `hooks/**` scope — the scope boundary is intentional (decision `quality-coverage-01`).

**Related:** `hooks-fail-closed` — the rule that governs the most critical observability failure in guard hooks (extraction failure → silent pass). When a guard hook violates `hooks-fail-closed`, it also violates this convention; `hooks-fail-closed` takes precedence at rule severity.

## Anti-Rationalization

| Excuse | Why It's Wrong | Correct Action |
|--------|---------------|----------------|
| "`|| true` is standard defensive shell scripting." | `|| true` converts non-zero exit codes into success — including unexpected failures. Without a comment, it makes the intent unverifiable. | Keep `|| true` where it is genuinely defensive; add a one-line comment naming what failure is being suppressed and why it is safe to ignore. |
| "Advisory hooks don't need to be observable — they're just nice-to-have." | Advisory hooks that silently fail become invisible cargo. Users assume they are running and producing correct output. A broken advisory hook is worse than no hook because it provides false confidence. | Emit `CANON WARNING:` to stderr when the hook's main detection logic cannot run (missing tool, failed query). |
| "A comment is overhead — the code is obvious." | If the swallow is obvious, the comment costs one line. If it is not obvious, the comment is necessary. Silent swallows are never truly obvious because they hide two possible states: "nothing to report" and "something broke." | Write the comment. Name the specific expected failure mode. |

## Verification

- [ ] Every `|| true` and `2>/dev/null` in `hooks/**` is accompanied by a comment naming the expected failure mode, or the failure path emits a `CANON WARNING:` line to stderr, or the failure path exits non-zero.
- [ ] Advisory hooks that call external tools (`sqlite3`, `jq`, `git`) with `|| true` either check the return value explicitly or emit a warning when the tool is absent.
- [ ] No guard hook has a bare silent swallow on its extraction or detection logic without a two-stage check or explicit justification comment.
