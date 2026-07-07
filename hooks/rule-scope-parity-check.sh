#!/bin/bash
# rule-scope-parity-check.sh — Deterministic rule<->agent wiring-parity gate.
# (sug_RULEPARITY1)
#
# Invoked by the verify contract (not as a hooks.json PreToolUse hook).
# Signature: bash hooks/rule-scope-parity-check.sh [worktree_path]
#
# Like context-manifest-gate.sh, this gate takes NO <base_commit> — wiring
# parity is a WHOLE-TREE property (does every agent named by a rule's scope
# actually carry that rule in its frontmatter `rules:` list). It recomputes over
# the current corpus; it never reads a git diff. Runs OFFLINE (frontmatter
# parsing is pure awk, no MCP).
#
# Run from the worktree root, OR pass the worktree as the optional trailing
# worktree_path arg (watch_CCCCCCCCCCCC2) — the gate resolves its source tree
# from that arg (or CWD when absent), not from git.
#
# For each rules/*.md whose frontmatter `scope.agents` is `all` (require every
# agent) or an explicit list (require each named agent), assert every required
# agent's frontmatter `rules:` array contains that rule id. Rules with no
# `scope.agents` (e.g. an orchestrator-dispatch rule) are IGNORED. When
# `scope.agents` is `all`, an optional sibling `scope.exclude:` list (inline
# `[a, b]` or multi-line) removes those agents from the required set — so
# `scope: { agents: all, exclude: [evaluator] }` requires every agent EXCEPT
# evaluator to wire the rule. `exclude:` has no effect on an explicit list. The agent set
# is every agents/*.md whose LEADING YAML frontmatter carries a `name:` field —
# a `name:` appearing outside frontmatter (e.g. in agents/README.md prose or a
# fenced example) is not an agent.
#
# Exit 0: every scope:all/explicit rule is wired to every agent it names.
# Exit 2: one or more (rule, agent) wirings are missing, OR the gate's own arg
#         prerequisites failed (non-directory worktree_path) — fail-closed
#         (hooks-fail-closed). Emits a CANON: diagnostic on stderr for every
#         failing path (hooks-observable-failures).

set -euo pipefail

WORKTREE_PATH="${1:-}"

if [[ -n "$WORKTREE_PATH" ]] && [[ ! -d "$WORKTREE_PATH" ]]; then
  echo "CANON: rule-scope-parity-check failed-closed — worktree_path not a directory: $WORKTREE_PATH" >&2
  exit 2
fi

ROOT="${WORKTREE_PATH:-$(pwd)}"

# ---------------------------------------------------------------------------
# awk: emit the agent name defined in a file's LEADING YAML frontmatter, or
# nothing. Frontmatter = the block between the first-line `---` and the next
# `---`. A `name:` outside that block (README prose / fenced example) is ignored.
# ---------------------------------------------------------------------------
agent_name() {
  awk '
    NR == 1 { if ($0 != "---") exit; infm = 1; next }
    infm && $0 == "---" { exit }
    infm && /^name:/ {
      line = $0
      sub(/^name:[[:space:]]*/, "", line)
      gsub(/["'"'"']/, "", line)
      sub(/[[:space:]]+$/, "", line)
      if (line != "") print line
      exit
    }
  ' "$1"
}

# ---------------------------------------------------------------------------
# awk: does a file's frontmatter `rules:` list contain the given id? Prints
# "yes" if so.
# ---------------------------------------------------------------------------
agent_has_rule() {
  awk -v want="$1" '
    NR == 1 { if ($0 != "---") exit; next }
    $0 == "---" { exit }
    /^rules:/ { inrules = 1; next }
    inrules && /^[a-zA-Z]/ { inrules = 0 }
    inrules && $0 ~ ("^  - " want "$") { print "yes"; exit }
  ' "$2"
}

# ---------------------------------------------------------------------------
# awk: emit a rule's required-agent scope. Prints "ALL" for scope.agents:all,
# a space-separated list of names for an explicit (inline or multi-line) list,
# or nothing when the rule has no scope.agents.
# ---------------------------------------------------------------------------
rule_scope() {
  awk '
    NR == 1 { if ($0 != "---") exit; next }
    $0 == "---" { exit }
    /^scope:/ { inscope = 1; next }
    inscope && /^[^[:space:]]/ { inscope = 0 }
    inscope && /^  agents:[[:space:]]*all[[:space:]]*$/ { print "ALL"; exit }
    inscope && /^  agents:[[:space:]]*\[/ {
      line = $0
      sub(/^  agents:[[:space:]]*\[/, "", line)
      sub(/\].*/, "", line)
      gsub(/[[:space:],]+/, " ", line)
      print line
      exit
    }
    inscope && /^  agents:[[:space:]]*$/ { inlist = 1; next }
    inlist && /^    -[[:space:]]*/ {
      v = $0
      sub(/^    -[[:space:]]*/, "", v)
      gsub(/[[:space:]]/, "", v)
      acc = acc " " v
      next
    }
    inlist && /^  [^[:space:]]/ { inlist = 0 }
    END { if (acc != "") print acc }
  ' "$1"
}

# ---------------------------------------------------------------------------
# awk: emit a rule's optional scope.exclude list — a space-separated list of
# agent names to remove from a scope:all required set. Handles both the inline
# (`exclude: [a, b]`) and multi-line list forms, mirroring rule_scope's agents
# parsing. Prints nothing when no exclude list is present.
# ---------------------------------------------------------------------------
rule_exclude() {
  awk '
    NR == 1 { if ($0 != "---") exit; next }
    $0 == "---" { exit }
    /^scope:/ { inscope = 1; next }
    inscope && /^[^[:space:]]/ { inscope = 0 }
    inscope && /^  exclude:[[:space:]]*\[/ {
      line = $0
      sub(/^  exclude:[[:space:]]*\[/, "", line)
      sub(/\].*/, "", line)
      gsub(/[[:space:],]+/, " ", line)
      print line
      exit
    }
    inscope && /^  exclude:[[:space:]]*$/ { inlist = 1; next }
    inlist && /^    -[[:space:]]*/ {
      v = $0
      sub(/^    -[[:space:]]*/, "", v)
      gsub(/[[:space:]]/, "", v)
      acc = acc " " v
      next
    }
    inlist && /^  [^[:space:]]/ { inlist = 0 }
    END { if (acc != "") print acc }
  ' "$1"
}

# ---------------------------------------------------------------------------
# Build the agent set: "name<TAB>file" rows.
# ---------------------------------------------------------------------------
AGENTS_FILE="$(mktemp)"
VIOL_FILE="$(mktemp)"
trap 'rm -f "$AGENTS_FILE" "$VIOL_FILE"' EXIT

shopt -s nullglob
for af in "$ROOT"/agents/*.md; do
  name="$(agent_name "$af")"
  [[ -z "$name" ]] && continue
  printf '%s\t%s\n' "$name" "$af" >> "$AGENTS_FILE"
done
shopt -u nullglob

# ---------------------------------------------------------------------------
# For each rule, resolve its required agents and check each is wired.
# ---------------------------------------------------------------------------
ALL_AGENT_NAMES="$(cut -f1 "$AGENTS_FILE" | sort -u)"

# lookup_agent_file <name> -> prints the agent file for that name, or nothing.
lookup_agent_file() {
  awk -F'\t' -v n="$1" '$1 == n { print $2; exit }' "$AGENTS_FILE"
}

shopt -s nullglob
for rf in "$ROOT"/rules/*.md; do
  rule_id="$(awk '/^id:/ { line = $0; sub(/^id:[[:space:]]*/, "", line); gsub(/["'"'"']/, "", line); sub(/[[:space:]]+$/, "", line); print line; exit }' "$rf")"
  [[ -z "$rule_id" ]] && continue

  scope="$(rule_scope "$rf")"
  [[ -z "$scope" ]] && continue

  if [[ "$scope" == "ALL" ]]; then
    # scope:all requires every agent MINUS an optional scope.exclude list.
    exclude="$(rule_exclude "$rf")"
    if [[ -z "$exclude" ]]; then
      required="$ALL_AGENT_NAMES"
    else
      required=""
      for agent in $ALL_AGENT_NAMES; do
        skip=false
        for ex in $exclude; do
          [[ "$agent" == "$ex" ]] && { skip=true; break; }
        done
        [[ "$skip" == "true" ]] && continue
        required="$required $agent"
      done
    fi
  else
    required="$scope"
  fi

  for agent in $required; do
    afile="$(lookup_agent_file "$agent")"
    # A named agent with no corresponding agent file cannot be verified; skip it
    # (out of scope — the rule references an agent the tree does not define).
    [[ -z "$afile" ]] && continue
    if [[ -z "$(agent_has_rule "$rule_id" "$afile")" ]]; then
      printf '%s missing from %s\n' "$rule_id" "$agent" >> "$VIOL_FILE"
    fi
  done
done
shopt -u nullglob

if [[ -s "$VIOL_FILE" ]]; then
  echo "CANON: rule-scope-parity-check — scope:agents:all/explicit rule(s) not wired:" >&2
  while IFS= read -r v; do
    [[ -n "$v" ]] && echo "  $v" >&2
  done < "$VIOL_FILE"
  exit 2
fi

echo "rule-scope-parity-check: rule<->agent wiring parity holds."
exit 0
