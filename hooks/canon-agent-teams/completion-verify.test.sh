#!/usr/bin/env bash
# Tests for completion-verify.sh.
# Exercises: feature-flag off, missing workspace, missing journal, complete
# flow, steps missing, artifacts missing, skipped steps.

set -euo pipefail

HOOK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/completion-verify.sh"

pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1" >&2; exit 1; }

SANDBOX=$(mktemp -d)
trap 'rm -rf "$SANDBOX"' EXIT

# 1. Feature-flag off — exit 0 even with no args.
CANON_AGENT_TEAMS_MODE=off bash "$HOOK" >/dev/null 2>&1 || fail "flag off should exit 0"
pass "flag off is no-op"

# 2. Missing workspace arg — exit 2.
if CANON_AGENT_TEAMS_MODE=on bash "$HOOK" >/dev/null 2>&1; then
  fail "missing workspace should exit 2"
fi
pass "missing workspace exits 2"

# 3. Missing journal — exit 2.
WS="$SANDBOX/no-journal"
mkdir -p "$WS"
if CANON_AGENT_TEAMS_MODE=on bash "$HOOK" "$WS" >/dev/null 2>&1; then
  fail "missing journal should exit 2"
fi
pass "missing journal exits 2"

# 4. Complete flow, artifacts exist — exit 0.
WS="$SANDBOX/complete"
mkdir -p "$WS/plans"
echo "# design" > "$WS/plans/DESIGN.md"
cat > "$WS/journal.json" <<'EOF'
{
  "version": 1,
  "workspace": "",
  "steps": [
    { "step_id": "s1", "agent_type": "architect", "artifacts_expected": ["plans/DESIGN.md"], "status": "completed", "started_at": "2026-04-21T10:00:00Z", "completed_at": "2026-04-21T10:05:00Z" }
  ]
}
EOF
out=$(CANON_AGENT_TEAMS_MODE=on bash "$HOOK" "$WS" 2>&1) || fail "complete flow should exit 0"
echo "$out" | grep -q 'Completion verified' || fail "expected 'Completion verified' output, got: $out"
pass "complete flow exits 0"

# 5. Steps missing — exit 2. Both started and planned count as missing.
WS="$SANDBOX/steps-missing"
mkdir -p "$WS"
cat > "$WS/journal.json" <<'EOF'
{
  "version": 1,
  "workspace": "",
  "steps": [
    { "step_id": "s1", "agent_type": null, "artifacts_expected": [], "status": "started", "started_at": "2026-04-21T10:00:00Z" }
  ]
}
EOF
if out=$(CANON_AGENT_TEAMS_MODE=on bash "$HOOK" "$WS" 2>&1); then
  fail "started-but-not-completed should exit 2"
fi
echo "$out" | grep -q 'Steps not completed: s1 (started)' || fail "expected 's1 (started)' in output: $out"
pass "started-but-not-completed exits 2"

# 5b. Planned step counts as missing (PR #119 P1 fix).
WS="$SANDBOX/steps-planned"
mkdir -p "$WS"
cat > "$WS/journal.json" <<'EOF'
{
  "version": 1,
  "workspace": "",
  "steps": [
    { "step_id": "s1", "agent_type": null, "artifacts_expected": [], "status": "planned" },
    { "step_id": "s2", "agent_type": null, "artifacts_expected": [], "status": "completed", "started_at": "2026-04-21T10:00:00Z", "completed_at": "2026-04-21T10:05:00Z" }
  ]
}
EOF
if out=$(CANON_AGENT_TEAMS_MODE=on bash "$HOOK" "$WS" 2>&1); then
  fail "planned step should exit 2"
fi
echo "$out" | grep -q 'Steps not completed: s1 (planned)' || fail "expected 's1 (planned)' in output: $out"
pass "planned steps block completion"

# 6. Artifacts missing — exit 2.
WS="$SANDBOX/art-missing"
mkdir -p "$WS"
cat > "$WS/journal.json" <<'EOF'
{
  "version": 1,
  "workspace": "",
  "steps": [
    { "step_id": "s1", "agent_type": null, "artifacts_expected": ["nope.md"], "status": "completed", "started_at": "2026-04-21T10:00:00Z", "completed_at": "2026-04-21T10:05:00Z" }
  ]
}
EOF
if out=$(CANON_AGENT_TEAMS_MODE=on bash "$HOOK" "$WS" 2>&1); then
  fail "missing artifact should exit 2"
fi
echo "$out" | grep -q 'Artifacts missing:' || fail "expected 'Artifacts missing:' in output: $out"
pass "missing artifacts exits 2"

# 7. Skipped steps are not counted as missing.
WS="$SANDBOX/skipped"
mkdir -p "$WS"
cat > "$WS/journal.json" <<'EOF'
{
  "version": 1,
  "workspace": "",
  "steps": [
    { "step_id": "s1", "agent_type": null, "artifacts_expected": [], "status": "skipped" },
    { "step_id": "s2", "agent_type": null, "artifacts_expected": [], "status": "completed", "started_at": "2026-04-21T10:00:00Z", "completed_at": "2026-04-21T10:05:00Z" }
  ]
}
EOF
CANON_AGENT_TEAMS_MODE=on bash "$HOOK" "$WS" >/dev/null 2>&1 || fail "skipped steps should not block completion"
pass "skipped steps do not block"

# 8. Glob patterns in artifacts_expected expand against disk (PR #119 P2 fix).
WS="$SANDBOX/glob"
mkdir -p "$WS/plans/my-slug"
echo '# design' > "$WS/plans/my-slug/DESIGN.md"
echo '# index'  > "$WS/plans/my-slug/INDEX.md"
cat > "$WS/journal.json" <<'EOF'
{
  "version": 1,
  "workspace": "",
  "steps": [
    { "step_id": "plan", "agent_type": null, "artifacts_expected": ["plans/my-slug/*.md"], "status": "completed", "started_at": "2026-04-21T10:00:00Z", "completed_at": "2026-04-21T10:05:00Z" }
  ]
}
EOF
out=$(CANON_AGENT_TEAMS_MODE=on bash "$HOOK" "$WS" 2>&1) || fail "glob artifact should match, exit 0. got: $out"
echo "$out" | grep -q 'Completion verified' || fail "expected 'Completion verified' for matching glob, got: $out"
pass "glob artifact patterns expand (matching case)"

# 9. Glob pattern with no match reports missing.
WS="$SANDBOX/glob-miss"
mkdir -p "$WS/plans/empty"
cat > "$WS/journal.json" <<'EOF'
{
  "version": 1,
  "workspace": "",
  "steps": [
    { "step_id": "plan", "agent_type": null, "artifacts_expected": ["plans/empty/*.md"], "status": "completed", "started_at": "2026-04-21T10:00:00Z", "completed_at": "2026-04-21T10:05:00Z" }
  ]
}
EOF
if out=$(CANON_AGENT_TEAMS_MODE=on bash "$HOOK" "$WS" 2>&1); then
  fail "glob with no matches should exit 2"
fi
echo "$out" | grep -q 'plans/empty/\*\.md' || fail "expected unmatched glob in output: $out"
pass "glob with no matches reports missing"

# 10. Unresolved ${var} patterns surface but do not block.
WS="$SANDBOX/var"
mkdir -p "$WS"
cat > "$WS/journal.json" <<'EOF'
{
  "version": 1,
  "workspace": "",
  "steps": [
    { "step_id": "plan", "agent_type": null, "artifacts_expected": ["plans/${slug}/DESIGN.md"], "status": "completed", "started_at": "2026-04-21T10:00:00Z", "completed_at": "2026-04-21T10:05:00Z" }
  ]
}
EOF
out=$(CANON_AGENT_TEAMS_MODE=on bash "$HOOK" "$WS" 2>&1) || fail "unresolved \${var} should not block: $out"
echo "$out" | grep -q 'Completion verified' || fail "expected 'Completion verified' despite unresolved var, got: $out"
pass "unresolved \${var} does not block completion"

echo "completion-verify.sh: all tests passed"
