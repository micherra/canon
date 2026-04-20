---
task_id: "v2_1a-05"
wave: 3
depends_on: ["v2_1a-06"]
decisions:
  - "dc-06"
files:
  - hooks/canon-agent-teams/canon-workspace-check.sh
  - hooks/canon-agent-teams/hooks.json
principles:
  - agent-surface-assumptions
  - agent-evidence-over-intuition
domains:
  - infrastructure
---

## Task: Ship L4 PreToolUse hook (`canon-workspace-check.sh`)

### Action

Create `hooks/canon-agent-teams/canon-workspace-check.sh` as a PreToolUse hook that blocks `Edit`, `Write`, and `Bash`-on-tracked-files when no active Canon workspace matches the current flow. This is the L4 hard-enforcement layer backstopping L1 (v2_1a-04) per v2.1 §2.10 layer 5 and §6.5.

**Allowlist rule (review HIGH-1 resolution):** the allowlist is `.gitignore`. `git check-ignore` is the oracle. Tracked files → in-scope for L4 blocking. Gitignored files → out-of-scope, always allowed.

**Decision table:**

| Tool | Argument pattern | Workspace state | Behavior |
|------|------------------|-----------------|----------|
| `Edit` | target path is tracked (`git check-ignore` returns non-zero) | no active `.canon/workspaces/<slug>/` matching current branch | **BLOCK** with message: "No active Canon workspace for this flow. Route the request through canon-planner." |
| `Edit` | target path is gitignored | any | **ALLOW** |
| `Write` | target path is tracked | no active workspace | **BLOCK** |
| `Write` | target path is gitignored | any | **ALLOW** |
| `Bash` | resolved target paths include any tracked file | no active workspace | **BLOCK** |
| `Bash` | resolved target paths all gitignored OR no file targets | any | **ALLOW** |

**"Current flow" detection:** check for `.canon/workspaces/<slug>/` where the workspace metadata lists the current branch (or HEAD's merge-base with a known workspace-active branch per existing Canon conventions). If lead is in plan mode or has not yet called `init_workspace`, no workspace exists; but per the bootstrap-contract assertion, L4 only fires on `Edit` / `Write` / tracked-Bash — not on the MCP tool calls used for `init_workspace` itself.

**Bash argument resolution:**
- Parse the Bash command string
- For redirect targets (`> file`, `>> file`, `tee file`, etc.), resolve the path
- For editor-style invocations (`sed -i`, `awk -i inplace`), resolve the `-i` target path
- For `git` subcommands that modify working tree (`git checkout`, `git reset --hard`, `git rm`), evaluate the targets
- For any resolved target, run `git check-ignore`; if zero exit (file is gitignored), that target does not cause a block
- Known false-negative modes (paths hidden inside `bash -c` with shell expansions) are acceptable — primary interactive surface is `Edit` / `Write`

**Register in `hooks/canon-agent-teams/hooks.json`:**

```json
{
  "PreToolUse": [
    {
      "matcher": "Edit|Write|Bash",
      "hooks": [{ "type": "command", "command": "./hooks/canon-agent-teams/canon-workspace-check.sh" }]
    }
  ]
}
```

**Bypass mechanism** — per review HIGH-1 recommended action #3, include an explicit bypass env var `CANON_BYPASS_WORKSPACE_CHECK=1` for one-shot overrides. Script checks this env var as the first gate; if set, exits 0 immediately. This is an escape hatch; default is unset.

**Bootstrap contract** — per review HIGH-1 recommended action #3, assert in the script header (as a comment) and in CLAUDE.md (v2_1a-04 amendment may reference this): L4 fires only on `Edit` / `Write` / tracked-Bash calls. The MCP tool calls used by the lead to call `init_workspace` are not `Edit` / `Write` / `Bash` and are never blocked. This means the lead can always create a workspace before L4 blocks any code-modifying tool.

### Canon principles to apply

- **agent-surface-assumptions** — the bypass env var and the bootstrap assertion are explicit; no implicit exceptions
- **agent-evidence-over-intuition** — `git check-ignore` is the oracle; no heuristic about "modifies code"

### Risk mitigations

- Intent misclassification drift (§13 MEDIUM/MEDIUM): L4 is the hard backstop for L1 failures. Defense in depth.
- No path enforcement in worktree isolation (§13 LOW/LOW): L4 partially addresses via the `.gitignore`-based predicate
- **Review HIGH-1 depends on v2_1a-06** (intent routing expansion) completing BEFORE this task lands; otherwise L4 blocks legitimate `canon-writer` / `canon-learner` runs

### Tests to write

- `hooks/canon-agent-teams/__tests__/canon-workspace-check.test.sh` (or equivalent test harness):
  - Test case: Edit on tracked file, no workspace → blocks
  - Test case: Edit on gitignored file, no workspace → allows
  - Test case: Edit on tracked file, workspace present → allows
  - Test case: Write on tracked file, no workspace → blocks
  - Test case: `bash -c 'sed -i ... README.md'` (tracked target), no workspace → blocks
  - Test case: `bash -c 'ls'` (no file targets), no workspace → allows
  - Test case: `CANON_BYPASS_WORKSPACE_CHECK=1` Edit on tracked file, no workspace → allows
  - Test case: MCP tool call (not Edit/Write/Bash) → not intercepted (matcher scope)
- Integration test (v2_1a-08):
  - canon-writer flow: creates workspace (v2_1a-06 prerequisite), edits `principles/*.md`, passes L4
  - canon-learner flow: creates workspace, writes to `.canon/proposed-learnings/` (gitignored), passes L4
  - Native drift: user edits tracked file outside any Canon flow → L4 blocks with actionable message

### Verify

1. Script exists and is executable
2. `hooks/canon-agent-teams/hooks.json` registers the hook under PreToolUse with matcher `Edit|Write|Bash`
3. Unit tests pass
4. Integration test passes against canon-writer + canon-learner flows (requires v2_1a-06 complete)
5. Bootstrap assertion documented in script header comment and cross-referenced from CLAUDE.md

### Done when

- Hook script + registration both present and exercised by tests
- Integration test with canon-writer / canon-learner passes (no false positives on legitimate flows)
- Bypass env var works
- v2_1a-06 (intent routing expansion) completed FIRST — this is a hard ordering requirement; otherwise false positives destroy user trust on day one
