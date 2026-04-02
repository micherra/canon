---
description: Diagnose Canon setup issues and validate configuration
argument-hint: [--fix]
allowed-tools: [Bash, Read, Glob, Grep]
model: haiku
---

Check the health of your Canon installation. Finds broken frontmatter, missing config, duplicate IDs, scope issues, MCP server problems, and other misconfigurations. Optionally fixes simple issues automatically.

## Instructions

### Step 1: Parse arguments

From ${ARGUMENTS}:
- `--fix`: Attempt to auto-fix simple issues (missing directories, malformed config)

### Step 2: Run diagnostic checks

Run all checks and collect results. Each check produces one of:
- **OK** — No issues
- **WARN** — Non-critical issue, Canon will still work
- **ERROR** — Something is broken and needs fixing

#### Check 1: Directory structure

Verify these directories exist:
- `.canon/` — project Canon root
- `.canon/principles/` — principle directory
- `.canon/principles/rules/`
- `.canon/principles/strong-opinions/`
- `.canon/principles/conventions/`
- `.canon/workspaces/` — build workspace storage
- `.canon/history/` — archived workspace history

If `--fix` and directories are missing, create them.

**ERROR** if `.canon/` doesn't exist: "Canon is not initialized. Run `/canon:init`."
**WARN** if severity subdirectories are missing: "Missing severity subdirectory: {dir}"
**WARN** if `.canon/workspaces/` is missing: "No workspaces directory. Will be created on first build."
**INFO** if `.canon/history/` is missing: optional, only exists after `clean --archive`.

#### Check 2: Config file

Check `.canon/config.json`:
- Exists?
- Valid JSON?
- Has expected keys (`principle_dirs`, `review`, `hook`)?

**WARN** if missing: "No config.json found. Run `/canon:init` to generate defaults."
**ERROR** if exists but invalid JSON: "config.json is malformed: {parse error}"

If `--fix` and missing, create with defaults.

#### Check 3: Principle frontmatter validation

Read every `.md` file in `.canon/principles/**/*.md`. For each, validate:
- Has YAML frontmatter (delimited by `---`)
- `id` field is present and non-empty
- `title` field is present and non-empty
- `severity` is one of: `rule`, `strong-opinion`, `convention`
- File is in the correct severity subdirectory (e.g., a `rule` severity principle should be in `rules/`)

**ERROR** for missing/invalid frontmatter: "{file}: Missing required field `{field}`"
**WARN** for severity/directory mismatch: "{file}: Severity is `{severity}` but file is in `{dir}/`"

#### Check 4: Duplicate IDs

Collect all `id` values across principles and agent-rules. Flag any duplicates.

**ERROR** for duplicates: "Duplicate ID `{id}` found in: {file1}, {file2}"

#### Check 5: Scope validation

For each principle, check:
- If `scope.layers` contains unrecognized layers (not in: `api`, `ui`, `domain`, `data`, `infra`, `shared`)
- If `scope.file_patterns` contains patterns that don't match any files in the project

**WARN** for unrecognized layers: "{id}: Unrecognized layer `{layer}`. Recognized: api, ui, domain, data, infra, shared"
**WARN** for unmatched patterns: "{id}: File pattern `{pattern}` matches no files in the project"

#### Check 6: Agent-rules validation

Read every `.md` file in `.canon/agent-rules/*.md` and `${CLAUDE_PLUGIN_ROOT}/agent-rules/*.md`. Validate:
- Has YAML frontmatter
- `id` starts with `agent-`
- `tags` include `agent-behavior`

**WARN** for missing `agent-` prefix: "{file}: Agent-rule ID should start with `agent-`"
**WARN** for missing tag: "{file}: Agent-rule should have `agent-behavior` tag"

#### Check 7: MCP server

Check if the MCP server can start:
```bash
cd ${CLAUDE_PLUGIN_ROOT}/mcp-server && node -e "require('./dist/index.js')" 2>&1 || echo "FAIL"
```

If that fails, check:
- `node_modules/` exists? If not: "Run `npm install` in `${CLAUDE_PLUGIN_ROOT}/mcp-server/`"
- `dist/` exists? If not: "Run `npm run build` in `${CLAUDE_PLUGIN_ROOT}/mcp-server/`"

**ERROR** if server can't load: "MCP server failed to load: {error}"
**WARN** if `node_modules/` missing: "MCP server dependencies not installed"

#### Check 8: CLAUDE.md integration

Check if `CLAUDE.md` exists and contains a Canon section.

**WARN** if missing Canon section: "CLAUDE.md doesn't reference Canon. Run `/canon:init` to add the integration."

#### Check 9: Data file integrity

For each `.jsonl` file (`.canon/reviews.jsonl`, `.canon/learning.jsonl`):
- If it exists, try parsing each line as JSON
- Flag lines that fail to parse

**WARN** for malformed lines: "{file}: Line {N} is not valid JSON"

#### Check 10: Convention bloat

If `.canon/CONVENTIONS.md` exists:
- Count convention lines (bullets starting with `- **`)
- If > 20 conventions: flag for compaction

**WARN** if > 20: "CONVENTIONS.md has {N} conventions — consider consolidating similar entries. CONVENTIONS.md is loaded into agent context on every spawn, so bloat directly costs tokens."

#### Check 11: Data file size

For each `.jsonl` file, count entries:
- If > 500 entries in the active file, rotation should have kicked in — warn if it didn't
- Check if `.archive.jsonl` files exist and report their sizes

**WARN** if > 500 entries in active file: "{file} has {N} entries — rotation may not be working. Expected max 500."
**INFO** if archive exists: "{file}.archive has {N} archived entries."

#### Check 12: Failed state transcript availability

For each workspace in `.canon/workspaces/`:
- Read `orchestration.db` and query `execution_states` for rows where `status = 'failed'` or `result` contains 'error' or 'stuck'
- Use try/catch around all SQLite queries — gracefully skip workspaces that predate the `transcript_path` column (migration v4) or have no `orchestration.db`
- For each failed state, check if `transcript_path` is set and the file exists
- If a failed state has a transcript, show the last 5 assistant-role entries as diagnostic context

**INFO** if failed state has transcript: "State '{state_id}' failed — transcript available at {path}. Last assistant message: {excerpt}"
**WARN** if failed state has no transcript: "State '{state_id}' failed but no transcript recorded — unable to show diagnostic context"

### Step 3: Present results

```markdown
## Canon Doctor

### Results

| # | Check | Status | Details |
|---|-------|--------|---------|
| 1 | Directory structure | OK | All directories present |
| 2 | Config file | WARN | No config.json found |
| 3 | Principle frontmatter | ERROR | 2 principles have issues |
| 4 | Duplicate IDs | OK | No duplicates |
| 5 | Scope validation | WARN | 1 unmatched file pattern |
| 6 | Agent-rules | OK | All valid |
| 7 | MCP server | OK | Server loads successfully |
| 8 | CLAUDE.md | OK | Canon section present |
| 9 | Data files | OK | All valid |
| 10 | Convention bloat | OK | 12 conventions |
| 11 | Data file size | OK | All within limits |
| 12 | Failed state transcripts | INFO | 1 failed state with transcript available |

### Issues

{List each WARN and ERROR with details and fix instructions}

### Summary
N checks passed, N warnings, N errors
```

If all checks pass: "Canon is healthy. No issues found."
If errors exist: "Found {N} error(s) that need fixing. {details}"
If only warnings: "Canon is functional but has {N} warning(s) worth addressing."

The summary count covers all 12 checks. Check 12 may produce INFO entries (not warnings or errors) when failed states have transcripts available for review.
