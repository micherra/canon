#!/bin/bash
# Canon Pre-Commit Check Hook
# Runs as a PreToolUse hook on Bash commands.
# Checks if the command is a git commit, and if so, reminds the agent
# to verify staged files against rule-severity Canon principles.
#
# Input: JSON on stdin with the tool call details
# Output: JSON with optional system message
# Exit 0: allow the tool call
# Exit 2: block the tool call (with message on stdout)

set -euo pipefail

# Read the tool input from stdin
INPUT=$(cat)

# Extract the command being run from the tool input
# The input JSON has a structure like: {"tool_name": "Bash", "tool_input": {"command": "..."}}
COMMAND=$(echo "$INPUT" | grep -o '"command"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"command"[[:space:]]*:[[:space:]]*"//;s/"$//' || true)

# If we couldn't extract a command, pass through
if [[ -z "$COMMAND" ]]; then
  exit 0
fi

# Check if this is a git commit command
if ! echo "$COMMAND" | grep -qE '\bgit\b.*\bcommit\b'; then
  exit 0
fi

# --- It's a git commit — check staged files against principles ---

# Find the principles directory
PRINCIPLES_DIR=""
if [[ -d ".canon/principles" ]]; then
  PRINCIPLES_DIR=".canon/principles"
elif [[ -n "${CLAUDE_PLUGIN_ROOT:-}" && -d "${CLAUDE_PLUGIN_ROOT}/principles" ]]; then
  PRINCIPLES_DIR="${CLAUDE_PLUGIN_ROOT}/principles"
fi

if [[ -z "$PRINCIPLES_DIR" ]]; then
  exit 0
fi

# Get staged files
STAGED_FILES=$(git diff --cached --name-only 2>/dev/null || true)
if [[ -z "$STAGED_FILES" ]]; then
  exit 0
fi

# Find the matcher script
MATCHER=""
if [[ -n "${CLAUDE_PLUGIN_ROOT:-}" && -f "${CLAUDE_PLUGIN_ROOT}/lib/principle-matcher.sh" ]]; then
  MATCHER="${CLAUDE_PLUGIN_ROOT}/lib/principle-matcher.sh"
elif [[ -f "$(dirname "${BASH_SOURCE[0]}")/../lib/principle-matcher.sh" ]]; then
  MATCHER="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib/principle-matcher.sh"
fi

if [[ -z "$MATCHER" ]]; then
  exit 0
fi

# --- Automated enforcement: detect secrets in staged files ---
# secrets-never-in-code is the one rule that CAN be pattern-matched.
# If secrets are detected, block the commit (exit 2).

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
  # Matches: password = "...", secret_key = "...", api_key: "..." etc. with values >= 16 chars
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

# --- Advisory: remind about other applicable rule-severity principles ---
APPLICABLE_RULES=""
while IFS= read -r file; do
  if [[ -n "$file" ]]; then
    RULES=$(bash "$MATCHER" --file "$file" --severity-filter rule --format text "$PRINCIPLES_DIR" 2>/dev/null || true)
    if [[ -n "$RULES" ]]; then
      APPLICABLE_RULES="${APPLICABLE_RULES}${RULES}"$'\n'
    fi
  fi
done <<< "$STAGED_FILES"

# Deduplicate
APPLICABLE_RULES=$(echo "$APPLICABLE_RULES" | sort -u | grep -v '^$' || true)

if [[ -z "$APPLICABLE_RULES" ]]; then
  exit 0
fi

# Count rules
RULE_COUNT=$(echo "$APPLICABLE_RULES" | wc -l | tr -d ' ')

# Output a reminder message for non-automatable rules
cat <<EOF
CANON PRE-COMMIT CHECK: ${RULE_COUNT} rule-severity principle(s) apply to the staged files.
Verify compliance before committing:

${APPLICABLE_RULES}

Review the staged changes against these principles. If any rule is violated,
fix the violation before committing. Use /canon:review --staged for a detailed check.
EOF

# Exit 0 — automated checks passed, advisory only for non-automatable rules
exit 0
