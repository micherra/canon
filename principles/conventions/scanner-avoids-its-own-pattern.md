---
id: scanner-avoids-its-own-pattern
title: A Scanner Must Not Contain the Literal Pattern It Detects
severity: convention
scope:
  layers:
    - hooks
  file_patterns:
    - "hooks/**"
    - "scripts/**"
    - "agents/*.md"
    - "rules/*.md"
    - "references/*.md"
tags:
  - hooks
  - verification
  - mechanical-checks
  - safety
---

A tool — hook, script, grep command, or verification step — that is designed to detect string pattern S must not contain S verbatim in an executable or intercepted position. When a pre-tool-use hook intercepts all Bash commands and pattern-matches on the command string, a grep or script that contains the literal form of S becomes indistinguishable from an instance of the defect being checked. The detection layer fires on the scanner itself.

**Resolution options (choose one):**

1. **Character-class split**: express the two-token pattern via a regex that matches it without reproducing it literally. For `bash -c` and `sh -c`: use `(ba)?sh[[:space:]]+-c` or `[bs][ah][s]h[[:space:]]+-c`.
2. **Token break**: concatenate parts of the pattern at execution time, or split across two grep passes.
3. **Indirect variable**: assign the sensitive token to a variable, then interpolate: `PAT='bash'; grep -E "$PAT -c"` — the literal form never appears in the source text the hook scans.
4. **Out-of-band invocation**: use a temp wrapper script that `source`s the target instead of invoking it via the pattern (e.g., `source "$script_path" "$@"` instead of the string-executing form).

## Why

Pre-tool-use hooks operate on the raw command string before it executes. A hook that scans for `bash -c` (or `eval`, or `git reset --hard`, or any other intercepted token) does so by matching against the entire command — including the arguments to a `grep` command that is itself searching for that pattern. The hook cannot distinguish:

- `grep 'bash -c' some_file.sh` (benign: verification grep)
- the two-token string appearing as an actual invocation

This is not a bug in the hook — fail-closed behavior on an unrecognizable command is correct (see `hooks-fail-closed`). It is a constraint on how verification and scanning commands must be written: they must avoid producing the literal form in any position the detection layer intercepts.

The same constraint applies when authoring mine scripts and code-analysis tools. A script designed to surface the `eval`/string-executing-wrapper defect class must not itself contain the defect it is designed to find, both for correctness and to avoid being blocked by the guard it is co-deployed with.

## Examples

### Verification grep for string-executing wrappers

**Bad — literal form in the grep pattern triggers the hook:**

```bash
# This grep is designed to check that no file uses the blocked form.
# But the grep command itself contains the literal form in its argument,
# which causes destructive-guard.sh to block it.
grep -rn 'bash -c' hooks/
```

**Good — character-class split avoids the literal form:**

```bash
# Matches 'bash -c' and 'sh -c' without containing either literal form.
grep -rn '(ba)?sh[[:space:]]\+-c' hooks/
```

### Parallel fan-out script that scans for a defect class

**Bad — script invokes a worker via the string-executing form:**

```bash
# The mine script is designed to detect shell-executing wrapper usage.
# Using the wrapper form in the mine script itself triggers the guard
# and also embeds the defect the script is designed to detect.
export -f process_item
xargs -P 8 -I{} bash -c 'process_item "$@"' _ {}
```

**Good — temp-wrapper approach using source instead:**

```bash
# Write a temp wrapper that sources this script and calls the function.
# No string-executing form appears in the mine script.
WRAPPER=$(mktemp /tmp/mine-worker-XXXXXX.sh)
cat > "$WRAPPER" <<'EOF'
#!/usr/bin/env bash
source "$MINE_SCRIPT_PATH"
process_item "$@"
EOF
chmod +x "$WRAPPER"
export MINE_SCRIPT_PATH="$0"
xargs -P 8 -I{} "$WRAPPER" {}
rm -f "$WRAPPER"
```

### Indirect variable for a single-token pattern

**Bad — literal `eval` in the grep argument:**

```bash
grep -rn 'eval ' src/
```

**Good — indirect variable so the literal form is never in source text:**

```bash
PAT='eval'
grep -rn "$PAT " src/
```

## Evidence

| # | Build | Scanner | Self-blocking form | Resolution |
|---|-------|---------|-------------------|------------|
| 1a | PR #355 (engineer) | `destructive-guard.sh` | `bash -c "$wrapper"` in xargs fan-out in mine script | Temp wrapper using `source` instead of the string-executing form |
| 1b | PR #355 (learner) | `destructive-guard.sh` | `grep ... 'bash -c'` as verification grep | Character-class split: `(ba)?sh[[:space:]]\+-c` |
| 2 | PR #337 fix | `destructive-guard.sh` | Verification greps for `eval`/the two-token form in target files | Pattern split via `(ba)?sh\s+-c` and related character-class forms |

## Exceptions

**Documented test fixtures**: A test file that intentionally contains the literal form as a fixture to verify the hook fires correctly is exempt, provided it carries a comment like `# fixture: intentional blocked pattern for hook test`. The file must not be executed in a context where the hook intercepts it.

**Out-of-scope hooks**: Hooks whose detection layer does not pattern-match on the command string as a whole (e.g., hooks that operate on structured JSON fields) are not subject to this constraint for string contents of those fields. The constraint applies wherever the detection layer intercepts raw command text.

## Anti-Rationalization

| Excuse | Why It's Wrong | Correct Action |
|--------|---------------|----------------|
| "It's just a grep argument — the hook shouldn't fire on arguments." | The hook fires on the entire command string, including arguments. This is correct fail-closed behavior. The grep author must account for it. | Use a character-class split or indirect variable. |
| "The character-class form is harder to read." | A slightly less readable regex is preferable to a verification command that is blocked by the hook it coexists with. | Add a comment explaining the form: `# character-class split avoids literal form triggering the hook`. |
| "I'll just exempt my grep from the hook." | Blanket exemptions widen the bypass surface and defeat the purpose of the guard. Exemptions are for exceptional cases with documented justification, not routine verification commands. | Use the character-class or indirect variable form. |

## Reviewer Check

When a new hook, script, or verification grep is added that detects pattern S (especially `eval`, `git reset --hard`, `git push --force`, or any other Canon-guarded token): check whether the script itself could trigger the detection layer for S. If it could, verify that one of the resolution approaches (character-class, token break, indirect variable, temp wrapper) is in use.

**See also:** `hooks-fail-closed` (rule) — the principle that makes fail-closed interception correct behavior and therefore makes this constraint unavoidable. `verification-grep-minimum-scope` (convention) — the complementary constraint on grep pattern specificity. `watch_QQQQQQ1` — the promoted convention covering the class of "a remediation that contains the defect it was designed to prevent."

## Verification

- [ ] New hooks or scripts that scan for pattern S do not contain S verbatim in an executable or intercepted position.
- [ ] New verification greps in agent files, rules, and references that scan for Canon-guarded patterns (`eval`, string-executing wrappers, destructive git ops) use character-class or indirect-variable forms.
- [ ] Any literal-pattern form found during review is accompanied by a test-fixture comment or a documented hook-exemption justification.
