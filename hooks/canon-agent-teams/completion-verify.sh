#!/usr/bin/env bash
# completion-verify.sh — Completion verification for agent-teams flows.
#
# Reads the orchestration journal at ${WORKSPACE}/journal.json, checks that
# every step is in a terminal state (completed or skipped) and that every
# expected artifact exists. Called by the lead before declaring a flow
# done (NOT registered as an automatic hook — see hooks.json comment).
# v2.1b will extend this to call snapshot_workspace after verify clears.
#
# The heavy lifting lives in a single node -e block so it stays in
# lockstep with features/orchestration/tools/orchestration-journal.ts
# (which is exactly what `verify_completion` reports). The node process
# formats its own human-readable output and sets the process exit code
# directly — bash just gates on the feature flag and resolves the
# workspace arg.
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

# One node invocation does everything: parse journal, resolve artifacts
# (including globs via fs.globSync), emit human text, set exit code.
# Semantics must mirror orchestration-journal.ts verifyCompletion.
# The workspace path and journal path are passed as argv (safer than
# env vars through exec, which doesn't propagate preceding assignments).
exec node -e '
  const fs = require("node:fs");
  // With `node -e script arg1 arg2`, argv is [nodePath, arg1, arg2].
  const [workspace, journalPath] = process.argv.slice(1);
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
  const steps = journal.steps || [];

  const missing = steps.filter(s => s.status === "planned" || s.status === "started");
  const completed = steps.filter(s => s.status === "completed");

  const artifactsMissing = [];
  const artifactsSkippedUnresolved = [];
  for (const step of completed) {
    for (const art of (step.artifacts_expected || [])) {
      if (art.includes("${")) {
        artifactsSkippedUnresolved.push(art);
        continue;
      }
      if (fs.globSync(art, { cwd: workspace }).length === 0) {
        artifactsMissing.push(art);
      }
    }
  }

  if (missing.length === 0 && artifactsMissing.length === 0) {
    console.log(`Completion verified: ${completed.length}/${steps.length} steps complete.`);
    process.exit(0);
  }

  console.error("INCOMPLETE FLOW:");
  if (missing.length) {
    const rendered = missing.map(s => `${s.step_id} (${s.status})`).join(", ");
    console.error(`  Steps not completed: ${rendered}`);
  }
  if (artifactsMissing.length) {
    console.error(`  Artifacts missing:   ${artifactsMissing.join(", ")}`);
  }
  if (artifactsSkippedUnresolved.length) {
    console.error(
      `  Unresolved \${var} artifact patterns (verify substitution): ${artifactsSkippedUnresolved.join(", ")}`,
    );
  }
  process.exit(2);
' "$WORKSPACE" "$JOURNAL"
