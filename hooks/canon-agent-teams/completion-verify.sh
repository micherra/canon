#!/usr/bin/env bash
# completion-verify.sh — Completion verification for agent-teams flows.
#
# Reads the orchestration journal at ${WORKSPACE}/journal.json, checks that
# every step is complete and every expected artifact exists. Called by the
# lead before declaring a flow done (NOT registered as an automatic hook —
# see hooks.json comment). v2.1b will extend this to call snapshot_workspace
# after verify clears.
#
# Input: CANON_WORKSPACE env var, or workspace path as $1.
# Exit 0: all steps complete, all artifacts present, or mode not active.
# Exit 2: incomplete — steps or artifacts missing, or journal unreadable.

set -euo pipefail

if [[ "${CANON_AGENT_TEAMS_MODE:-off}" != "on" ]]; then
  exit 0
fi

WORKSPACE="${CANON_WORKSPACE:-${1:-}}"

if [[ -z "$WORKSPACE" ]]; then
  echo "ERROR: No workspace specified. Set CANON_WORKSPACE or pass as \$1." >&2
  exit 2
fi

JOURNAL="$WORKSPACE/journal.json"

if [[ ! -f "$JOURNAL" ]]; then
  echo "ERROR: No orchestration journal found at $JOURNAL" >&2
  echo "The lead must call log_step for each runbook step." >&2
  exit 2
fi

# Parse via node (required in Canon environments per MCP server engine reqs).
# Emits a single JSON blob on stdout, or exits non-zero on parse error.
#
# Semantics must mirror features/orchestration/tools/orchestration-journal.ts
# so the hook and the MCP tool agree. In particular:
#   - planned + started both count as "missing" (not just started).
#   - Glob patterns in artifact paths (*, ?, [...]) are expanded — a
#     pattern is missing only when no match exists on disk.
#   - ${var} template fragments are surfaced via artifacts_skipped_unresolved
#     but do not count as missing.
RESULT=$(WORKSPACE="$WORKSPACE" JOURNAL="$JOURNAL" node -e '
  const fs = require("fs");
  const path = require("path");
  const workspace = process.env.WORKSPACE;
  const journal = JSON.parse(fs.readFileSync(process.env.JOURNAL, "utf8"));
  const steps = journal.steps || [];
  const missing = steps.filter(s => s.status === "planned" || s.status === "started");
  const completed = steps.filter(s => s.status === "completed");
  const skipped = steps.filter(s => s.status === "skipped");

  function segmentRegex(segment) {
    const escaped = segment.replace(/[.+^${}()|\\]/g, "\\$&");
    const pattern = escaped.replace(/\*/g, ".*").replace(/\?/g, ".");
    return new RegExp("^" + pattern + "$");
  }

  function globMatch(base, segs) {
    if (!fs.existsSync(base)) return false;
    try { if (!fs.statSync(base).isDirectory()) return false; } catch { return false; }
    const [head, ...rest] = segs;
    if (!head) return true;
    const re = segmentRegex(head);
    for (const entry of fs.readdirSync(base)) {
      if (!re.test(entry)) continue;
      const next = path.join(base, entry);
      if (rest.length === 0) return true;
      try {
        if (fs.statSync(next).isDirectory() && globMatch(next, rest)) return true;
      } catch { /* broken symlink, etc */ }
    }
    return false;
  }

  function artifactExists(art) {
    const full = path.isAbsolute(art) ? art : path.resolve(workspace, art);
    if (!/[*?[]/.test(art)) return fs.existsSync(full);
    const segs = full.split(/[\\/]/);
    let prefixIdx = 0;
    while (prefixIdx < segs.length && !/[*?[]/.test(segs[prefixIdx] || "")) prefixIdx++;
    const prefix = segs.slice(0, prefixIdx).join("/") || "/";
    const patternSegs = segs.slice(prefixIdx);
    if (patternSegs.length === 0) return fs.existsSync(prefix);
    return globMatch(prefix, patternSegs);
  }

  const artifactsMissing = [];
  const artifactsSkippedUnresolved = [];
  for (const step of completed) {
    for (const art of (step.artifacts_expected || [])) {
      if (art.includes("${")) {
        artifactsSkippedUnresolved.push(art);
        continue;
      }
      if (!artifactExists(art)) {
        artifactsMissing.push(art);
      }
    }
  }

  process.stdout.write(JSON.stringify({
    artifacts_missing: artifactsMissing,
    artifacts_skipped_unresolved: artifactsSkippedUnresolved,
    complete: missing.length === 0 && artifactsMissing.length === 0,
    steps_completed: completed.length,
    steps_logged: steps.length,
    steps_missing: missing.map(s => ({ step_id: s.step_id, status: s.status })),
    steps_skipped: skipped.map(s => s.step_id),
  }));
' 2>/dev/null || true)

if [[ -z "$RESULT" ]]; then
  echo "ERROR: Failed to parse journal at $JOURNAL" >&2
  exit 2
fi

COMPLETE=$(printf '%s' "$RESULT" | node -e '
  process.stdout.write(
    JSON.parse(require("fs").readFileSync(0, "utf8")).complete.toString()
  );
')

if [[ "$COMPLETE" == "true" ]]; then
  STEPS_LOGGED=$(printf '%s' "$RESULT" | node -e '
    process.stdout.write(
      JSON.parse(require("fs").readFileSync(0, "utf8")).steps_logged.toString()
    );
  ')
  STEPS_COMPLETED=$(printf '%s' "$RESULT" | node -e '
    process.stdout.write(
      JSON.parse(require("fs").readFileSync(0, "utf8")).steps_completed.toString()
    );
  ')
  echo "Completion verified: $STEPS_COMPLETED/$STEPS_LOGGED steps complete."
  exit 0
fi

echo "INCOMPLETE FLOW:" >&2
printf '%s' "$RESULT" | node -e '
  const r = JSON.parse(require("fs").readFileSync(0, "utf8"));
  if (r.steps_missing && r.steps_missing.length) {
    const rendered = r.steps_missing
      .map(s => s.step_id + " (" + s.status + ")")
      .join(", ");
    console.error("  Steps not completed: " + rendered);
  }
  if (r.artifacts_missing && r.artifacts_missing.length) {
    console.error("  Artifacts missing:   " + r.artifacts_missing.join(", "));
  }
  if (r.artifacts_skipped_unresolved && r.artifacts_skipped_unresolved.length) {
    console.error("  Unresolved ${var} artifact patterns (verify substitution): "
      + r.artifacts_skipped_unresolved.join(", "));
  }
'
exit 2
