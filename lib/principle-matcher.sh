#!/bin/bash
# Canon Principle Matcher
# Matches principles to a given context using YAML frontmatter parsing.
# No external dependencies — uses only grep/sed/awk.
#
# Usage:
#   principle-matcher.sh [OPTIONS] [PRINCIPLES_DIR...]
#
# Options:
#   --language LANG         Filter by programming language (e.g., typescript, python)
#   --layer LAYER           Filter by architectural layer (e.g., api, domain, data)
#   --file FILE_PATH        Filter by file path (glob-matched against file_patterns)
#   --severity-filter LEVEL Only return principles at this severity or higher
#                           (rule > strong-opinion > convention)
#   --tag-filter TAG        Only return principles with this tag (repeatable)
#   --max N                 Maximum number of results (default: 0 = no limit)
#                           Results are sorted: rules first, then by specificity
#   --format json|text      Output format (default: json)
#
# If no PRINCIPLES_DIR given, checks .canon/principles/ then falls back to
# the plugin's own principles/ directory.

set -euo pipefail

# --- Defaults ---
LANGUAGE=""
LAYER=""
FILE_PATH=""
SEVERITY_FILTER=""
TAG_FILTERS=()
MAX_RESULTS=0
OUTPUT_FORMAT="json"
PRINCIPLES_DIRS=()

# --- Parse arguments ---
while [[ $# -gt 0 ]]; do
  case "$1" in
    --language)
      LANGUAGE="$2"; shift 2 ;;
    --layer)
      LAYER="$2"; shift 2 ;;
    --file)
      FILE_PATH="$2"; shift 2 ;;
    --severity-filter)
      SEVERITY_FILTER="$2"; shift 2 ;;
    --tag-filter)
      TAG_FILTERS+=("$2"); shift 2 ;;
    --max)
      MAX_RESULTS="$2"; shift 2 ;;
    --format)
      OUTPUT_FORMAT="$2"; shift 2 ;;
    --all)
      shift ;;
    -*)
      echo "Unknown option: $1" >&2; exit 1 ;;
    *)
      PRINCIPLES_DIRS+=("$1"); shift ;;
  esac
done

# --- Resolve principle directories ---
if [[ ${#PRINCIPLES_DIRS[@]} -eq 0 ]]; then
  if [[ -d ".canon/principles" ]]; then
    PRINCIPLES_DIRS+=(".canon/principles")
  fi
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  PLUGIN_PRINCIPLES="${SCRIPT_DIR}/../principles"
  if [[ -d "$PLUGIN_PRINCIPLES" ]]; then
    PRINCIPLES_DIRS+=("$PLUGIN_PRINCIPLES")
  fi
fi

if [[ ${#PRINCIPLES_DIRS[@]} -eq 0 ]]; then
  echo "[]"
  exit 0
fi

# --- Infer language from file extension ---
infer_language() {
  local filepath="$1"
  case "$filepath" in
    *.ts|*.tsx)  echo "typescript" ;;
    *.js|*.jsx)  echo "javascript" ;;
    *.py)        echo "python" ;;
    *.java)      echo "java" ;;
    *.go)        echo "go" ;;
    *.rs)        echo "rust" ;;
    *.rb)        echo "ruby" ;;
    *.tf)        echo "terraform" ;;
    *)           echo "" ;;
  esac
}

# --- Infer layer from file path ---
infer_layer() {
  local filepath="$1"
  case "$filepath" in
    */api/*|*/routes/*|*/controllers/*)  echo "api" ;;
    */components/*|*/pages/*|*/views/*)  echo "ui" ;;
    */services/*|*/domain/*|*/models/*)  echo "domain" ;;
    */db/*|*/data/*|*/repositories/*|*/prisma/*)  echo "data" ;;
    */infra/*|*/deploy/*|*/terraform/*|*/docker/*)  echo "infra" ;;
    */utils/*|*/lib/*|*/shared/*|*/types/*)  echo "shared" ;;
    *)  echo "" ;;
  esac
}

# --- Auto-infer from FILE_PATH if not explicitly set ---
if [[ -n "$FILE_PATH" && -z "$LANGUAGE" ]]; then
  LANGUAGE=$(infer_language "$FILE_PATH")
fi
if [[ -n "$FILE_PATH" && -z "$LAYER" ]]; then
  LAYER=$(infer_layer "$FILE_PATH")
fi

# --- Severity ranking ---
severity_rank() {
  case "$1" in
    rule)            echo 1 ;;
    strong-opinion)  echo 2 ;;
    convention)      echo 3 ;;
    *)               echo 9 ;;
  esac
}

severity_passes_filter() {
  local severity="$1"
  local filter="$2"
  if [[ -z "$filter" ]]; then
    return 0
  fi
  local sev_rank
  sev_rank=$(severity_rank "$severity")
  local filter_rank
  filter_rank=$(severity_rank "$filter")
  [[ $sev_rank -le $filter_rank ]]
}

# --- Extract YAML frontmatter ---
extract_frontmatter() {
  awk '
    /^---$/ { count++; next }
    count == 1 { print }
    count >= 2 { exit }
  ' "$1"
}

# --- Get scalar field from frontmatter ---
get_field() {
  local fm="$1"
  local field="$2"
  echo "$fm" | grep "^${field}:" | head -1 | sed "s/^${field}:[[:space:]]*//" | sed 's/^"\(.*\)"$/\1/' | sed "s/^'\(.*\)'$/\1/"
}

# --- Get array values (inline [a, b] or multi-line "  - val") ---
get_array() {
  local fm="$1"
  local field="$2"
  # Try inline array first: field: [val1, val2]
  local line
  line=$(echo "$fm" | grep -E "^[[:space:]]*${field}:" | head -1)
  if [[ -z "$line" ]]; then
    return
  fi
  # Check for inline array: field: [val1, val2]
  if echo "$line" | grep -q '\['; then
    local inline
    inline=$(echo "$line" | sed 's/.*\[//;s/\].*//' | tr ',' '\n' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | sed 's/^"//;s/"$//' | sed "s/^'//;s/'$//" | grep -v '^$')
    if [[ -n "$inline" ]]; then
      echo "$inline"
      return
    fi
  fi
  # Multi-line array: collect "  - value" lines after the field
  local field_indent
  field_indent=$(echo "$line" | sed 's/[^ ].*//' | wc -c)
  echo "$fm" | awk -v field="$field" -v fi="$field_indent" '
    BEGIN { found = 0 }
    {
      # Match the field line (with optional indent)
      stripped = $0
      gsub(/^[[:space:]]*/, "", stripped)
      if (found == 0 && index(stripped, field ":") == 1) {
        found = 1
        next
      }
      if (found == 1) {
        if (/^[[:space:]]*- /) {
          sub(/^[[:space:]]*- /, "")
          gsub(/"/, "")
          gsub(/'\''/, "")
          print
        } else if (/^[[:space:]]*$/) {
          next
        } else {
          found = 0
        }
      }
    }
  '
}

# --- Glob match (simplified: supports * and **) ---
glob_match() {
  local pattern="$1"
  local filepath="$2"
  # Convert glob to regex
  local regex
  regex=$(echo "$pattern" | sed 's/\./\\./g' | sed 's/\*\*/DOUBLESTAR/g' | sed 's/\*/[^\/]*/g' | sed 's/DOUBLESTAR/.*/g')
  echo "$filepath" | grep -qE "^${regex}$" 2>/dev/null || echo "$filepath" | grep -qE "(^|/)${regex}$" 2>/dev/null
}

# --- Process all principle files ---
SEEN_IDS=()
RESULTS=()

process_principle() {
  local file="$1"
  local fm
  fm=$(extract_frontmatter "$file")
  if [[ -z "$fm" ]]; then
    return
  fi

  local id
  id=$(get_field "$fm" "id")
  if [[ -z "$id" ]]; then
    return
  fi

  # Skip duplicate IDs (project-local takes precedence)
  for seen in "${SEEN_IDS[@]+"${SEEN_IDS[@]}"}"; do
    if [[ "$seen" == "$id" ]]; then
      return
    fi
  done
  SEEN_IDS+=("$id")

  local title severity
  title=$(get_field "$fm" "title")
  severity=$(get_field "$fm" "severity")

  # Validate severity is a known value
  if [[ "$severity" != "rule" && "$severity" != "strong-opinion" && "$severity" != "convention" ]]; then
    return
  fi

  # --- Apply filters ---

  # Severity filter
  if ! severity_passes_filter "$severity" "$SEVERITY_FILTER"; then
    return
  fi

  # Language filter
  if [[ -n "$LANGUAGE" ]]; then
    local langs
    langs=$(get_array "$fm" "languages")
    if [[ -n "$langs" ]]; then
      if ! echo "$langs" | grep -qi "^${LANGUAGE}$"; then
        return
      fi
    fi
    # Empty languages list = matches all
  fi

  # Layer filter
  if [[ -n "$LAYER" ]]; then
    local layers
    layers=$(get_array "$fm" "layers")
    if [[ -n "$layers" ]]; then
      if ! echo "$layers" | grep -qi "^${LAYER}$"; then
        return
      fi
    fi
    # Empty layers list = matches all
  fi

  # File pattern filter
  if [[ -n "$FILE_PATH" ]]; then
    local patterns
    patterns=$(get_array "$fm" "file_patterns")
    if [[ -n "$patterns" ]]; then
      local matched=false
      while IFS= read -r pattern; do
        if [[ -n "$pattern" ]] && glob_match "$pattern" "$FILE_PATH"; then
          matched=true
          break
        fi
      done <<< "$patterns"
      if [[ "$matched" == "false" ]]; then
        return
      fi
    fi
    # Empty file_patterns = matches all
  fi

  # Get tags
  local tags_list
  tags_list=$(get_array "$fm" "tags")
  local tags
  tags=$(echo "$tags_list" | tr '\n' ',' | sed 's/,$//')

  # Tag filter: if tag filters specified, principle must have at least one
  if [[ ${#TAG_FILTERS[@]} -gt 0 ]]; then
    local tag_matched=false
    for tf in "${TAG_FILTERS[@]}"; do
      if echo "$tags_list" | grep -qi "^${tf}$"; then
        tag_matched=true
        break
      fi
    done
    if [[ "$tag_matched" == "false" ]]; then
      return
    fi
  fi

  local sev_rank
  sev_rank=$(severity_rank "$severity")

  # Specificity score: principles with more constraints rank higher
  # 0 = unconstrained (broad), 1 = has layers OR file_patterns, 2 = has both
  local specificity=0
  local has_layers
  has_layers=$(get_array "$fm" "layers")
  local has_patterns
  has_patterns=$(get_array "$fm" "file_patterns")
  if [[ -n "$has_layers" ]]; then specificity=$((specificity + 1)); fi
  if [[ -n "$has_patterns" ]]; then specificity=$((specificity + 1)); fi

  # Sort key: severity first (1-3), then inverse specificity (0=specific, 2=broad)
  # This ensures rules come first, then within same severity, specific > broad
  local inv_spec=$((2 - specificity))

  RESULTS+=("${sev_rank}|${inv_spec}|${id}|${title}|${severity}|${tags}|$(realpath "$file" 2>/dev/null || echo "$file")")
}

# Process directories in order (project-local first for precedence)
for dir in "${PRINCIPLES_DIRS[@]}"; do
  if [[ -d "$dir" ]]; then
    for file in "$dir"/*.md; do
      if [[ -f "$file" ]]; then
        process_principle "$file"
      fi
    done
  fi
done

# --- Sort by severity rank, then specificity ---
IFS=$'\n' SORTED=($(printf '%s\n' "${RESULTS[@]+"${RESULTS[@]}"}" | sort -t'|' -k1,1n -k2,2n))
unset IFS

# --- Apply max results cap ---
if [[ "$MAX_RESULTS" -gt 0 && ${#SORTED[@]} -gt "$MAX_RESULTS" ]]; then
  SORTED=("${SORTED[@]:0:$MAX_RESULTS}")
fi

# --- Output ---
if [[ "$OUTPUT_FORMAT" == "json" ]]; then
  echo "["
  first=true
  for entry in "${SORTED[@]+"${SORTED[@]}"}"; do
    IFS='|' read -r rank spec id title severity tags filepath <<< "$entry"
    if [[ "$first" == "true" ]]; then
      first=false
    else
      echo ","
    fi
    printf '  {"id": "%s", "title": "%s", "severity": "%s", "tags": "%s", "file": "%s"}' \
      "$id" "$title" "$severity" "$tags" "$filepath"
  done
  echo ""
  echo "]"
else
  for entry in "${SORTED[@]+"${SORTED[@]}"}"; do
    IFS='|' read -r rank spec id title severity tags filepath <<< "$entry"
    printf "%-30s %-15s %s\n" "$id" "$severity" "$title"
  done
fi
