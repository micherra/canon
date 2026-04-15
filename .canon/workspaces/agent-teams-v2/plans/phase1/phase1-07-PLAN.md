---
task_id: "phase1-07"
wave: 2
depends_on:
  - "phase1-00"
  - "phase1-01"
  - "phase1-02"
  - "phase1-03"
  - "phase1-04"
files:
  - hooks/canon-agent-teams/post-commit-trailers.sh
  - hooks/canon-agent-teams/completion-verify.sh
  - hooks/canon-agent-teams/hooks.json
principles:
  - agent-tdd-required
domains:
  - hooks
---

## Task: Write agent-teams hook scripts and hooks.json

### Action

Create two hook scripts and a hooks.json configuration for the agent-teams mode. These provide defense-in-depth enforcement (§2.8 layer 5 of migration plan).

#### 1. Create directory structure

```bash
mkdir -p hooks/canon-agent-teams/
```

#### 2. Write `post-commit-trailers.sh`

This is a PostCommit hook that validates the `Canon-Workflow` trailer is present in commits made during agent-teams mode.

```bash
#!/usr/bin/env bash
# post-commit-trailers.sh — PostCommit hook validating Canon-Workflow trailer
# Only active when CANON_AGENT_TEAMS_MODE=on
# Exit 0: trailer present or mode not active
# Exit 2: trailer missing (blocks the commit)

set -euo pipefail

# Only enforce when agent-teams mode is active
if [[ "${CANON_AGENT_TEAMS_MODE:-off}" != "on" ]]; then
  exit 0
fi

# Read the tool input from stdin (Claude Code PostToolUse hook format)
# The hook receives the Bash tool output including the git commit command
INPUT=$(cat)

# Check if this was a git commit command
if ! echo "$INPUT" | grep -q '"tool_name".*"Bash"'; then
  exit 0
fi

COMMAND=$(echo "$INPUT" | grep -o '"command"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/"command"[[:space:]]*:[[:space:]]*"//;s/"$//')

if ! echo "$COMMAND" | grep -qE 'git\s+commit'; then
  exit 0
fi

# Get the last commit message
LAST_MSG=$(git log -1 --format='%B' 2>/dev/null || echo "")

# Check for Canon-Workflow trailer
if echo "$LAST_MSG" | grep -q '^Canon-Workflow:'; then
  exit 0
fi

# Trailer missing — report but don't block (warn via stderr)
# Using exit 0 for now as PostToolUse hooks that exit non-zero
# may interfere with the commit that already happened.
# The completion-verify hook provides the hard enforcement.
echo "WARNING: Commit missing Canon-Workflow trailer. Expected format:" >&2
echo "  Canon-Workflow: {workflow-slug}" >&2
echo "  Canon-Agent: {agent-type}" >&2
echo "  Canon-State: {state-id}" >&2
exit 0
```

Note: PostCommit hooks in Claude Code run AFTER the commit, so they cannot block retroactively. This hook warns. The real enforcement is that agents are instructed to include trailers, and `completion-verify.sh` catches systemic omissions at flow end.

#### 3. Write `completion-verify.sh`

This hook calls `verify_completion` via the Canon MCP server's CLI interface (or reads the journal directly) to check whether the flow is complete.

```bash
#!/usr/bin/env bash
# completion-verify.sh ��� Completion verification hook
# Reads the orchestration journal and verifies all steps are complete.
# Called by the lead before declaring a flow done.
# Exit 0: all steps complete, all artifacts present
# Exit 2: incomplete — steps or artifacts missing

set -euo pipefail

# Only enforce when agent-teams mode is active
if [[ "${CANON_AGENT_TEAMS_MODE:-off}" != "on" ]]; then
  exit 0
fi

# Get workspace from environment or argument
WORKSPACE="${CANON_WORKSPACE:-${1:-}}"

if [[ -z "$WORKSPACE" ]]; then
  echo "ERROR: No workspace specified. Set CANON_WORKSPACE or pass as argument." >&2
  exit 2
fi

JOURNAL="$WORKSPACE/journal.json"

if [[ ! -f "$JOURNAL" ]]; then
  echo "ERROR: No orchestration journal found at $JOURNAL" >&2
  echo "The lead must call log_step for each runbook step." >&2
  exit 2
fi

# Parse journal using node (available in Canon environments)
RESULT=$(node -e "
  const j = JSON.parse(require('fs').readFileSync('$JOURNAL', 'utf8'));
  const steps = j.steps || [];
  const missing = steps.filter(s => s.status === 'started');
  const completed = steps.filter(s => s.status === 'completed');
  const skipped = steps.filter(s => s.status === 'skipped');

  // Check artifacts
  const path = require('path');
  const fs = require('fs');
  const artifactsMissing = [];
  for (const step of completed) {
    for (const art of (step.artifacts_expected || [])) {
      // Skip paths with unresolved variables
      if (art.includes('\${')) continue;
      const full = path.resolve('$WORKSPACE', art);
      if (!fs.existsSync(full)) {
        artifactsMissing.push(art);
      }
    }
  }

  console.log(JSON.stringify({
    steps_logged: steps.length,
    steps_completed: completed.length,
    steps_missing: missing.map(s => s.step_id),
    steps_skipped: skipped.map(s => s.step_id),
    artifacts_missing: artifactsMissing,
    complete: missing.length === 0 && artifactsMissing.length === 0
  }));
" 2>/dev/null)

if [[ -z "$RESULT" ]]; then
  echo "ERROR: Failed to parse journal at $JOURNAL" >&2
  exit 2
fi

COMPLETE=$(echo "$RESULT" | node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).complete.toString())")

if [[ "$COMPLETE" == "true" ]]; then
  STEPS_LOGGED=$(echo "$RESULT" | node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).steps_logged.toString())")
  STEPS_COMPLETED=$(echo "$RESULT" | node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).steps_completed.toString())")
  echo "Completion verified: $STEPS_COMPLETED/$STEPS_LOGGED steps complete."
  exit 0
fi

# Incomplete — report details
echo "INCOMPLETE FLOW:" >&2
MISSING=$(echo "$RESULT" | node -e "
  const r = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  if (r.steps_missing.length) console.log('  Steps not completed: ' + r.steps_missing.join(', '));
  if (r.artifacts_missing.length) console.log('  Artifacts missing: ' + r.artifacts_missing.join(', '));
")
echo "$MISSING" >&2
exit 2
```

#### 4. Write `hooks/canon-agent-teams/hooks.json`

```json
{
  "description": "Canon agent-teams hooks — commit trailer validation and completion verification. Active only when CANON_AGENT_TEAMS_MODE=on.",
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "bash ${CLAUDE_PLUGIN_ROOT}/hooks/canon-agent-teams/post-commit-trailers.sh",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

Note: The `completion-verify.sh` hook is NOT registered in hooks.json as a PostToolUse hook — it is called explicitly by the lead (or by the CLAUDE.md completion checklist) before declaring a flow done. It is a verification script, not an automatic hook. If it were a PostToolUse hook, it would fire on every Bash command which is wrong. Instead, the lead's CLAUDE.md orchestration guidance instructs: "Before calling `update_board complete_flow`, run `bash ${CLAUDE_PLUGIN_ROOT}/hooks/canon-agent-teams/completion-verify.sh`".

### Canon principles to apply
- **agent-tdd-required**: Write tests for both hook scripts.

### Risk mitigations
- **Feature flag isolation**: Both scripts check `CANON_AGENT_TEAMS_MODE` first and exit 0 if not active. This ensures they are no-ops when the flag is off.
- **PostCommit hook limitation**: PostCommit hooks cannot block already-committed work. The trailer hook warns only. The completion-verify hook is the hard enforcement gate at flow end.
- **Node availability**: `completion-verify.sh` requires `node` to parse JSON. This is safe in Canon environments (Node.js 24+ is required by the MCP server).

### Tests to write
- `hooks/canon-agent-teams/post-commit-trailers.test.sh`: Test that the hook exits 0 when mode is off, exits 0 when trailer is present, and warns when trailer is missing.
- `hooks/canon-agent-teams/completion-verify.test.sh`: Test that the hook exits 0 when all steps complete, exits 2 when steps are missing, exits 2 when artifacts are missing, exits 2 when no journal exists, and exits 0 when mode is off.

### Verify
1. Both scripts are executable: `chmod +x hooks/canon-agent-teams/*.sh`
2. `hooks/canon-agent-teams/hooks.json` parses as valid JSON
3. Test scripts pass:
   - `bash hooks/canon-agent-teams/post-commit-trailers.test.sh`
   - `bash hooks/canon-agent-teams/completion-verify.test.sh`
4. Feature flag gating: both scripts exit 0 when `CANON_AGENT_TEAMS_MODE` is unset
5. `npm run build` passes (no TypeScript changes)
6. `npm test` passes (no test changes)
7. The existing `hooks/hooks.json` is NOT modified

### Done when
- `hooks/canon-agent-teams/post-commit-trailers.sh` exists and validates Canon-Workflow trailer
- `hooks/canon-agent-teams/completion-verify.sh` exists and verifies journal completion
- `hooks/canon-agent-teams/hooks.json` exists with PostToolUse registration for the trailer hook
- Both scripts gate on `CANON_AGENT_TEAMS_MODE=on`
- Test scripts written and passing
- Existing hooks untouched
- Build and tests pass unchanged
