---
id: security-guard-threat-model-doc
title: Security Guard Hooks Document Their Threat-Model Boundary
severity: convention
portable: false
scope:
  layers: []
  file_patterns:
    - "hooks/**"
tags:
  - security
  - hooks
  - documentation
---

Every hook that acts as a security guard (can exit non-zero to BLOCK an operation) must carry a top-of-file comment block documenting: (1) what it catches — the threat class it prevents; (2) what it does NOT catch — bypass surfaces such as `chmod -x`, direct plumbing, or CI runners that don't route through it; (3) the authoritative control that actually enforces the invariant (e.g. GitHub branch-protection rulesets, CODEOWNERS); (4) the fail-closed invariant, referencing `hooks-fail-closed` or the relevant done-criteria.

## Rationale

A security guard hook that documents only what it blocks invites over-reliance: a reader assumes the hook IS the control, and skips or weakens the authoritative control (branch protection, CODEOWNERS) because "the hook already handles it." A hook is defense-in-depth, not a substitute for the platform-level control it fronts — it runs client-side, before a push reaches the server, and can be bypassed by anyone who doesn't route through the intercepted tool call.

Writing the threat-model boundary down at the point of definition — what's caught, what isn't, and what the real authority is — forces the author to confront the gap explicitly rather than let the hook's presence create a false sense of completeness. It also gives the next engineer who extends the hook a concrete boundary to reason against instead of re-deriving it from the implementation.

## Examples

**Bad — hook with no threat-model documentation:**

```bash
#!/usr/bin/env bash
# Blocks direct pushes to main.
set -euo pipefail
# ... parsing and blocking logic ...
```

A reader has no way to know this hook is bypassable by `git push --no-verify`, by a CI runner that doesn't invoke Claude Code's hook system, or by `chmod -x` on the script itself — and no way to know GitHub branch-protection is the actual backstop.

**Good — hook documents its threat-model boundary:**

```bash
#!/usr/bin/env bash
# push-to-main-guard.sh — blocks direct `git push` to main/master from within
# Claude Code's Bash tool.
#
# CATCHES: git push (and equivalent plumbing forms) targeting main/master,
#   invoked via Claude Code's Bash tool.
# DOES NOT CATCH: pushes from outside Claude Code (a human's terminal, CI
#   runners, other tools); `--no-verify`-equivalent bypasses of the hook
#   system itself; a maintainer with direct git/GitHub access.
# AUTHORITATIVE CONTROL: GitHub branch-protection rules on main/master are
#   the real enforcement boundary. This hook is accident-prevention
#   defense-in-depth for the common case, not a security boundary.
# FAIL-CLOSED: see hooks-fail-closed — unparseable input blocks, never passes.
set -euo pipefail
# ... parsing and blocking logic ...
```

## Exceptions

Hooks that are purely observational (log-only, never block — exit 0 unconditionally) are not security guards under this convention and do not need a threat-model block. A hook whose blocking behavior is trivially self-evident from its name and a one-line comment (no meaningful bypass surface to document) may use a shorter form, but must still name the authoritative control if one exists.

## Anti-Rationalization

| Excuse | Why It's Wrong | Correct Action |
|--------|---------------|----------------|
| "The hook's logic is self-explanatory from the code." | The threat-model boundary — what it does NOT catch and what the real authority is — is not derivable from reading the blocking logic; it requires knowing what was deliberately left out. | Write the boundary down explicitly; do not rely on a reader inferring gaps from absence. |
| "We don't have a bypass surface worth documenting." | Every client-side hook has at least one bypass surface (direct git/API access, `--no-verify`, a runner that skips the hook). | Name the bypass surface even if it seems obvious — that's exactly the assumption that leads to over-reliance. |
| "This is defense-in-depth, so the threat model doesn't matter." | Defense-in-depth is precisely why the boundary must be documented — a reader needs to know what still needs its own authoritative control. | Document the authoritative control alongside the hook so nobody treats the hook as sufficient on its own. |

## Verification

- [ ] Every `hooks/**` script that can exit non-zero to block an operation has a top-of-file comment documenting: catches, does-not-catch, authoritative control, and fail-closed invariant.
- [ ] Any deviation (observational-only hook, trivially self-evident hook) is documented under `## Exceptions` with rationale.

## Related

[[hooks-fail-closed]], [[hooks-observable-failures]], [[security-hook-parser-allowlist-posture]]. Reference implementation: `hooks/push-to-main-guard.sh` lines 5-16.
