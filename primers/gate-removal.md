---
id: gate-removal
title: Feature Flag Gate Removal Checklist
domain: hooks
audience: planner, engineer
---

# Feature Flag Gate Removal

When removing a feature-flag gate from shell scripts (hooks, build scripts, etc.), the removal scope extends beyond the gate code block itself. Use this 5-item checklist to ensure complete removal:

## Checklist

1. **Gate code block** — the conditional that exits early when the flag is off:
   ```bash
   # e.g.:
   if [[ "${FLAG_NAME:-off}" != "on" ]]; then
     exit 0
   fi
   ```

2. **Inline comment preceding the gate** — often a `# Only run when FLAG_NAME is enabled` line immediately above the gate block.

3. **File-level header comment about activation condition** — header comments like `# Only active when FLAG_NAME=on.` that describe the script's activation scope. These are separate from the gate code and easily missed.

4. **Flag-off test case** — test files often have a dedicated test like "should exit 0 when FLAG_NAME is off" that exercises the early-exit path. Remove the entire test case.

5. **Flag variable prefix in remaining test invocations** — after removing the gate, remaining test calls may still prefix with `FLAG_NAME=on` (e.g., `FLAG_NAME=on bash "$HOOK" ...`). Remove the prefix — the hook now runs unconditionally.

## When to Load This Primer

Load when:
- A build request mentions removing a feature flag, env var gate, or conditional activation
- The planner identifies flag-removal as part of a larger build scope
- The research notes enumerate hook scripts with gating code

## Lesson Learned

In PR #191 (P1 protocol gap fixes), 6/9 hook scripts retained stale file-level header comments like `# Only active when CANON_AGENT_TEAMS_MODE=on.` after gate code was removed. The research notes correctly specified the 3-line code block removal pattern but missed items 2, 3, and 5. A follow-up fix commit was required.
