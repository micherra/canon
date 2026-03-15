#!/bin/bash
# Canon Pre-Commit Check Hook
# Runs as a PreToolUse hook on Bash commands.
# Checks if the command is a git commit, and if so, scans staged files
# for hardcoded secrets. Blocks the commit if any are found.
#
# Input: JSON on stdin with the tool call details
# Output: plain-text diagnostic on stdout (when blocking)
# Exit 0: allow the tool call
# Exit 2: block the tool call (plain-text reason on stdout)

set -euo pipefail

# Read the tool input from stdin
INPUT=$(cat)

# Extract the command being run from the tool input
COMMAND=$(echo "$INPUT" | grep -o '"command"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"command"[[:space:]]*:[[:space:]]*"//;s/"$//' || true)

# If we couldn't extract a command, pass through
if [[ -z "$COMMAND" ]]; then
  exit 0
fi

# Check if this is a git commit command
if ! echo "$COMMAND" | grep -qE '\bgit\b.*\bcommit\b'; then
  exit 0
fi

# Get staged files
STAGED_FILES=$(git diff --cached --name-only 2>/dev/null || true)
if [[ -z "$STAGED_FILES" ]]; then
  exit 0
fi

# --- Detect secrets in staged files ---

SECRET_VIOLATIONS=""
while IFS= read -r file; do
  if [[ -z "$file" ]]; then continue; fi

  # Skip binary files, .env.example, and test files
  case "$file" in
    *.env.example|*.test.*|*.spec.*|*__tests__*|*.png|*.jpg|*.ico|*.lock) continue ;;
  esac

  # Get staged content for this file
  CONTENT=$(git show ":${file}" 2>/dev/null || true)
  if [[ -z "$CONTENT" ]]; then continue; fi

  # Check for common secret patterns (high-confidence patterns only)
  HITS=""

  # AWS access keys (AKIA followed by 16 alphanumeric chars)
  if echo "$CONTENT" | grep -qE 'AKIA[0-9A-Z]{16}'; then
    HITS="${HITS}  - AWS access key pattern detected\n"
  fi

  # Private keys
  if echo "$CONTENT" | grep -qE -- '-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY'; then
    HITS="${HITS}  - Private key detected\n"
  fi

  # High-entropy strings assigned to variables with secret-like names
  if echo "$CONTENT" | grep -qEi '(password|secret|api_key|apikey|secret_key|access_key|private_key|auth_token)[[:space:]]*[:=][[:space:]]*"[^"]{16,}"'; then
    HITS="${HITS}  - Hardcoded credential in variable assignment\n"
  fi

  # Stripe secret keys (sk_live_)
  if echo "$CONTENT" | grep -qE 'sk_live_[a-zA-Z0-9]{20,}'; then
    HITS="${HITS}  - Stripe live secret key detected\n"
  fi

  # Connection strings with embedded passwords
  if echo "$CONTENT" | grep -qE '(postgres|mysql|mongodb|redis)://[^:]+:[^@]{4,}@'; then
    HITS="${HITS}  - Connection string with embedded password\n"
  fi

  if [[ -n "$HITS" ]]; then
    SECRET_VIOLATIONS="${SECRET_VIOLATIONS}**${file}**:\n${HITS}\n"
  fi
done <<< "$STAGED_FILES"

# If secrets detected, BLOCK the commit (exit 2)
if [[ -n "$SECRET_VIOLATIONS" ]]; then
  cat <<EOF
CANON PRE-COMMIT BLOCK: secrets-never-in-code (rule) — potential secrets detected in staged files.

${SECRET_VIOLATIONS}
Secrets must never be committed to source code. Externalize them via environment
variables or a secret manager. If these are false positives (test fixtures, placeholders),
use obviously fake values or move them to gitignored files.

Fix the violations before committing. See: /canon:explain secrets-never-in-code
EOF
  exit 2
fi

# No secrets found — allow the commit
exit 0
