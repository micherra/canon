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

Read every `.md` file in `.canon/rules/*.md` and `${CLAUDE_PLUGIN_ROOT}/rules/*.md`. Validate:
- Has YAML frontmatter
- `id` starts with `agent-`
- `tags` include `agent-behavior`

**WARN** for missing `agent-` prefix: "{file}: Agent-rule ID should start with `agent-`"
**WARN** for missing tag: "{file}: Agent-rule should have `agent-behavior` tag"

#### Check 7: MCP server

Check the MCP server boot health using the real runtime diagnostic:
```bash
bash ${CLAUDE_PLUGIN_ROOT}/mcp-server/boot.sh --print-resolution 2>&1
```

`boot.sh --print-resolution` is side-effect-free (no server started) and always exits 0.
It prints three lines:
```
<SERVER_DIR> <NODE_PATH> <TSX_BIN>   ← legacy positional line (line 1)
NODE_VERSION=<v-prefixed string or empty>
RESOLUTION_STATUS=<ok|tsx-missing|node-missing|node-too-old>
```

**Important:** Line 1 contains raw filesystem paths that may include spaces (e.g. macOS
`~/Library/Application Support/...`). Do NOT parse `TSX_BIN` from line 1 by positional field
splitting — use `RESOLUTION_STATUS` (no spaces in value) as the authoritative signal instead.

Parse the output:
- Grep for `^RESOLUTION_STATUS=` and split on `=` to extract the status value.
- Grep for `^NODE_VERSION=` and split on `=` to extract the version string.
- If stdout contains `CANON ERROR:` (emitted on stderr before Step 11 and exits 1), capture
  that text as the failure message.

**Healthy** only when:
- Exit code is 0
- `RESOLUTION_STATUS=ok`

**ERROR** cases:

| RESOLUTION_STATUS | Message | Remediation |
|---|---|---|
| `tsx-missing` | "MCP server boot check failed: dependencies not installed" | "Run `npm install` in `${CLAUDE_PLUGIN_ROOT}/mcp-server/`" |
| `node-missing` | "MCP server boot check failed: `node` not found on PATH" | "Install Node v24+" |
| `node-too-old` | "MCP server boot check failed: Node {NODE_VERSION} is too old" | "Upgrade Node.js to v24+ (found {NODE_VERSION})" |
| _(exit 1 / CANON ERROR)_ | "MCP server boot check failed: {CANON ERROR message}" | "Reinstall Canon or check `CLAUDE_PLUGIN_ROOT`" — e.g. `CANON ERROR: cannot resolve MCP server dir` means the plugin directory is misconfigured or the symlink is dangling |

Check 7 only validates that the MCP server *can* boot (`boot.sh --print-resolution`
is a static resolution check — no server is started). It says nothing about
whether an already-running HTTP daemon is reachable or on the right version.
Check 7b below covers that live-runtime case.

#### Check 7b: HTTP daemon health and recovery

This check is diagnostic by default and only takes action with explicit user
confirmation — unlike Check 7, it probes the *live* daemon process, not a
static resolution.

**Step 1 — Is HTTP daemon mode enabled?**

If `CANON_HTTP_DAEMON` is not `1`, this check is not applicable: **OK** —
"HTTP daemon mode not enabled (stdio MCP transport in use); nothing to check."
Skip the remaining steps.

**Step 2 — Resolve the latest installed plugin version.** Same resolution
`hooks/canon-agent-teams/daemon-version-nudge.sh` uses: the max-semver sibling
directory of `$CLAUDE_PLUGIN_ROOT`'s parent (a mid-session `plugin-update`
writes a new sibling dir; `CLAUDE_PLUGIN_ROOT` itself is pinned at session
start and would miss it):

```bash
PARENT="$(dirname "$CLAUDE_PLUGIN_ROOT")"
INSTALLED_VERSION=$(
  for d in "$PARENT"/*/; do
    [[ -d "$d" ]] || continue
    b="$(basename "$d")"
    [[ "$b" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] && echo "$b"
  done | sort -t. -k1,1n -k2,2n -k3,3n | tail -n1
)
```

**Step 3 — Probe the running daemon's `/health` endpoint** (same grep/sed idiom
as `hooks/canon-agent-teams/session-start-daemon-supervisor.sh`):

```bash
PORT="${CANON_DAEMON_PORT:-3142}"
HEALTH=$(curl -s -m 2 "http://127.0.0.1:${PORT}/health" 2>/dev/null)
DAEMON_VERSION=$(echo "$HEALTH" | grep -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' | head -n1 | sed 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')
```

**Step 4 — Diagnose** (explicit match/mismatch/unreachable — this replaces the
old diagnostics-only gap, where the nudge hook's "run `/canon:doctor`"
remediation pointer led nowhere):

| Condition | Status | Message |
|---|---|---|
| `$HEALTH` is empty (no response within the timeout) | ERROR | "HTTP daemon unreachable on 127.0.0.1:{PORT}. `mcp__canon__*` tool calls will fail this session." |
| `$DAEMON_VERSION` == `$INSTALLED_VERSION` | OK | "Daemon healthy, running v{DAEMON_VERSION}." |
| `$DAEMON_VERSION` != `$INSTALLED_VERSION` (both non-empty) | WARN | "Daemon stale: running v{DAEMON_VERSION}, latest installed v{INSTALLED_VERSION}." |

**Step 5 — Recovery (ERROR or WARN only; ASK-FIRST, never automatic).**

Before offering recovery, warn the user: *the daemon is a shared multi-session
singleton — restarting it will error in-flight `mcp__canon__*` calls in any
OTHER active Canon session, not just this one.* Only proceed on explicit
confirmation. This ask-first restart inside a user-invoked `/canon:doctor` run
is the sanctioned restart moment for this daemon (the supervisor's own
`SessionStart` hook only self-heals opportunistically; anything stronger
requires a human decision at a quiescent moment).

On confirmation, run the version handoff — the fresh cache dir for
`$INSTALLED_VERSION` may not yet have `node_modules`/`tsx` installed, so
deps-install MUST run before the supervisor or the boot fails with "tsx not
found":

```bash
export CANON_HTTP_DAEMON=1
export CLAUDE_PLUGIN_DATA="${CLAUDE_PLUGIN_DATA:-$HOME/.claude/plugins/data/canon-canon-marketplace}"
LATEST_CACHE_DIR="$PARENT/$INSTALLED_VERSION"
bash "$LATEST_CACHE_DIR/hooks/canon-agent-teams/session-start-deps-install.sh"
bash "$LATEST_CACHE_DIR/hooks/canon-agent-teams/session-start-daemon-supervisor.sh"
curl -s -m 2 "http://127.0.0.1:${PORT}/health"
```

`session-start-daemon-supervisor.sh` performs the identity-validated kill +
handoff + health poll (see its SessionStart contract in
`hooks/.claude/CLAUDE.md`) — it will not touch a non-Canon process on the
port. `CLAUDE_PLUGIN_DATA` must resolve to the actual marketplace data
directory for this install; adjust the default above if the project uses a
different plugin source. Confirm the re-probed `/health` now reports
`$INSTALLED_VERSION`, then remind the user to run `/mcp` to reconnect this
session to the fresh daemon.

If the user declines recovery, report the diagnosis only (WARN/ERROR per Step
4) and take no further action.

#### Check 8: CLAUDE.md integration

Check if `CLAUDE.md` exists and contains a Canon section.

**WARN** if missing Canon section: "CLAUDE.md doesn't reference Canon. Run `/canon:init` to add the integration."

#### Check 9: Data file integrity

**This is the primary net for append corruption** (ADR-0058 D7): `append_learning_record`
makes the sanctioned path safe, but its grantees still hold `Bash`, and nothing mechanically
stops a hand-rolled `>>` append from bypassing the tool. This check is what catches that
bypass — do not trim it as redundant now that the tool exists.

For each of the five active append-target stores — `.canon/learning.jsonl`,
`.canon/reviews.jsonl`, `.canon/learning-pending.jsonl`, `.canon/flow-runs.jsonl`,
`.canon/patterns.jsonl` — if the file exists:
- **Leading indicator**: check whether the file ends with a trailing newline. A missing final
  newline is a merge that hasn't happened yet — the next append will land on the open line.
- **Lagging indicator**: try parsing each line as JSON. Flag lines that fail to parse. Skip
  blank lines first (a line that is empty or whitespace-only is not a parse failure) — the
  sanctioned append primitive's healing TOCTOU (`jsonl-append.ts`) can legitimately produce a
  blank line when two concurrent appends both observe a non-newline last byte and both prefix a
  healing `\n`; that is strictly better than the pre-ADR-0058 merge it replaces and must not be
  flagged as corruption.

**WARN** for a missing final newline: "{file}: does not end with a newline — the next append
will merge onto this line."
**WARN** for malformed lines: "{file}: Line {N} is not valid JSON"

**Scope exclusion**: do NOT extend either check to `.canon/history/**/transcripts/*.jsonl`.
Those files are write-once and never re-appended, so a missing final newline there is
harmless — flagging them would bury this check under a large volume of false positives and
train reviewers to ignore it.

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
- Use try/catch around all SQLite queries — gracefully skip workspaces that predate the `transcript_path` column (migration v4, schema version 4) or have no `orchestration.db`
- For each failed state, check if `transcript_path` is set and the file exists
- If a failed state has a transcript, show the last 5 assistant-role entries as diagnostic context

**INFO** if failed state has transcript: "State '{state_id}' failed — transcript available at {path}. Last assistant message: {excerpt}"
**WARN** if failed state has no transcript: "State '{state_id}' failed but no transcript recorded — unable to show diagnostic context"

#### Check 13: Context staleness

Call `check_context_staleness({ project_dir: ${CLAUDE_PLUGIN_ROOT} })` to compare the installed artifact corpus against the committed `context-manifest.json`.

The tool returns a `StalenessReport` with three arrays:
- `drifted` — files present in both the manifest and the installed tree but with different content hashes (file was modified post-install)
- `missing` — files in the manifest that are absent or unreadable in the installed tree
- `extra` — files in the installed corpus that are not listed in the manifest (new files added since the manifest was generated)

Render one row per finding:

| Finding | Status | Path |
|---------|--------|------|
| drifted | WARN | `{path}` |
| missing | ERROR | `{path}` |
| extra | WARN | `{path}` |

**OK** if `clean: true`: "Context artifacts match manifest. No drift detected."
**WARN** for drifted or extra paths: "Context artifact `{path}` has drifted from the committed manifest."
**ERROR** for missing paths: "Context artifact `{path}` is listed in the manifest but absent from the installed tree."
**ERROR** if `check_context_staleness` returns `MANIFEST_NOT_FOUND`: "context-manifest.json not found at `${CLAUDE_PLUGIN_ROOT}/context-manifest.json`. Run `cd mcp-server && npm run regen:context-manifest` from the repo root to regenerate it."

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
| 7b | HTTP daemon health | OK | Daemon healthy, running v2.17.0 |
| 8 | CLAUDE.md | OK | Canon section present |
| 9 | Data files | OK | All valid |
| 10 | Convention bloat | OK | 12 conventions |
| 11 | Data file size | OK | All within limits |
| 12 | Failed state transcripts | INFO | 1 failed state with transcript available |
| 13 | Context staleness | OK | Context artifacts match manifest |

### Issues

{List each WARN and ERROR with details and fix instructions}

### Summary
N checks passed, N warnings, N errors
```

If all checks pass: "Canon is healthy. No issues found."
If errors exist: "Found {N} error(s) that need fixing. {details}"
If only warnings: "Canon is functional but has {N} warning(s) worth addressing."

The summary count covers all 13 numbered checks plus Check 7b. Check 7b is
skipped (OK, not counted as a check run) when `CANON_HTTP_DAEMON` is not `1`.
Check 12 may produce INFO entries (not warnings or errors) when failed states
have transcripts available for review. Check 13 reports context artifact
drift between the installed plugin and the committed manifest.
