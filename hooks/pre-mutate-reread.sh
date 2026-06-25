#!/bin/bash
# pre-mutate-reread.sh — Pre-mutate stale-read freshness validator
#
# USAGE
#   bash hooks/pre-mutate-reread.sh <artifact_path> [max_age_seconds]
#
# Validates that an on-disk artifact has not advanced beyond a caller-held
# in-context snapshot. Called by agents before multi-step journal/board writes
# to detect the "read-then-long-compute-then-stale-write" hazard.
#
# HOW IT WORKS
#   The script compares the file's current mtime against a freshness threshold.
#   If the file was modified more recently than `max_age_seconds` ago AND the
#   caller's snapshot timestamp (passed via the CANON_SNAPSHOT_TS env var) is
#   older than the file's mtime, it warns that the file may have been modified
#   by another session since the caller last read it.
#
#   CANON_SNAPSHOT_TS (optional): ISO-8601 or epoch seconds of when the caller
#   last read the artifact. When absent, the script only checks absolute mtime
#   against max_age_seconds (advisory age check).
#
# EXIT CODES
#   0 — artifact is fresh / no stale-read hazard detected (pass, always)
#
# OUTPUT
#   stdout: warning message if a stale-read hazard is detected; empty otherwise
#
# NOTE: This script is advisory only — it always exits 0. The Pre-Mutate Re-Read
# Gate protocol (CLAUDE.md § Multi-Session Concurrency) is the behavioral
# enforcement; this script provides a detectable signal at the hook layer.
# Never use this script's output as a hard block — stale-read recovery should
# go through the BOARD_LOCKED retry path or user HITL.
#
# EXAMPLES
#   # Before writing journal.json, check if it was modified in last 30s
#   bash hooks/pre-mutate-reread.sh "$WORKSPACE/journal.json" 30
#
#   # With snapshot timestamp for precise staleness check
#   CANON_SNAPSHOT_TS="$LAST_READ_TS" bash hooks/pre-mutate-reread.sh "$WORKSPACE/journal.json"

set -euo pipefail

ARTIFACT_PATH="${1:-}"
MAX_AGE_SECONDS="${2:-60}"  # default: warn if modified in last 60 seconds

if [[ -z "$ARTIFACT_PATH" ]]; then
  >&2 echo "CANON WARNING: [pre-mutate-reread] Usage: $0 <artifact_path> [max_age_seconds]"
  exit 0
fi

if [[ ! -f "$ARTIFACT_PATH" ]]; then
  # Artifact does not exist — no stale-read hazard (fresh create)
  exit 0
fi

# Get file mtime as epoch seconds (portable: GNU date and macOS date both supported)
FILE_MTIME=0
if date -r "$ARTIFACT_PATH" +%s >/dev/null 2>&1; then
  FILE_MTIME=$(date -r "$ARTIFACT_PATH" +%s)  # macOS / BSD
elif stat --format="%Y" "$ARTIFACT_PATH" >/dev/null 2>&1; then
  FILE_MTIME=$(stat --format="%Y" "$ARTIFACT_PATH")  # GNU/Linux
fi

if [[ "$FILE_MTIME" -eq 0 ]]; then
  # Cannot stat mtime — skip check
  exit 0
fi

NOW_EPOCH=$(date +%s)
AGE_SECONDS=$(( NOW_EPOCH - FILE_MTIME ))

# Check 1: was the file modified more recently than max_age_seconds?
if [[ "$AGE_SECONDS" -le "$MAX_AGE_SECONDS" ]]; then
  # File was recently modified — check if we have a snapshot timestamp to compare
  SNAPSHOT_TS="${CANON_SNAPSHOT_TS:-}"

  if [[ -n "$SNAPSHOT_TS" ]]; then
    # Parse snapshot timestamp to epoch (ISO-8601 or plain epoch)
    SNAPSHOT_EPOCH=0
    if [[ "$SNAPSHOT_TS" =~ ^[0-9]+$ ]]; then
      SNAPSHOT_EPOCH="$SNAPSHOT_TS"
    elif date -d "$SNAPSHOT_TS" +%s >/dev/null 2>&1; then
      SNAPSHOT_EPOCH=$(date -d "$SNAPSHOT_TS" +%s)  # GNU
    elif date -jf "%Y-%m-%dT%H:%M:%S" "${SNAPSHOT_TS%Z}" +%s >/dev/null 2>&1; then
      SNAPSHOT_EPOCH=$(date -jf "%Y-%m-%dT%H:%M:%S" "${SNAPSHOT_TS%Z}" +%s)  # macOS
    fi

    if [[ "$SNAPSHOT_EPOCH" -gt 0 ]] && [[ "$FILE_MTIME" -gt "$SNAPSHOT_EPOCH" ]]; then
      echo "CANON WARNING: [pre-mutate-reread] Stale-read hazard detected."
      echo "  Artifact: ${ARTIFACT_PATH}"
      echo "  Last read (snapshot): $(date -r "$SNAPSHOT_EPOCH" 2>/dev/null || echo "${SNAPSHOT_TS}")"
      echo "  Current mtime:        $(date -r "$FILE_MTIME" 2>/dev/null || echo "${FILE_MTIME}")"
      echo "  The artifact was modified by another session since your last read."
      echo "  Re-read ${ARTIFACT_PATH} before writing to avoid overwriting concurrent changes."
    fi
  else
    # No snapshot — advisory age warning only
    if [[ "$AGE_SECONDS" -le 10 ]]; then
      echo "CANON WARNING: [pre-mutate-reread] Recently modified artifact (${AGE_SECONDS}s ago): ${ARTIFACT_PATH}"
      echo "  Another session may have written this file. Re-read before mutating."
    fi
  fi
fi

exit 0
