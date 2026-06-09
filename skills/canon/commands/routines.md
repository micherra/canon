---
description: Manage Canon routines — list, enable, disable, delete, or sync scheduled-task artifacts
argument-hint: [list|enable <name>|disable <name>|delete <name>|sync [<name>]]
allowed-tools: [Read, Bash, Glob, Grep, Agent, mcp__canon__sync_routines]
model: sonnet
---

Manage Canon routines — first-class scheduled-task artifacts stored in `routines/` (project) or the Canon plugin `routines/` directory.

**Important**: Sync writes (SKILL.md files, recipe emissions) happen ONLY via this command's `sync` subcommand. The session-start hook (`session-start-routines-check.sh`) is read-only and advisory — it never writes files.

## Parse Arguments

From `${ARGUMENTS}`, extract the subcommand and optional name:

- **`list`** (default when no arguments): List all routines with status and binding.
- **`enable <name>`**: Flip `status: enabled` in the routine artifact, then regenerate the index.
- **`disable <name>`**: Flip `status: disabled` in the routine artifact, then regenerate the index.
- **`delete <name>`**: Remove the routine artifact and flag/remove its live binding.
- **`sync [<name>]`**: Sync one routine (by name) or all enabled routines. This is the ONLY path that writes SKILL.md files or emits cloud recipes.

If no arguments are provided, default to `list`.

## Step 1: Locate Routines

Find routines from two sources (project-local takes precedence on name conflict):
- Project-local: `.canon/routines/` in the current project directory
- Plugin: `${CLAUDE_PLUGIN_ROOT}/routines/`

Use `Glob` to enumerate `*.md` files in each directory (skip `README.md` and `.claude/` subdirs).

## Step 2: Execute Subcommand

### list

Load all routines. For each routine, resolve its binding target:
- `git-native` + not daemon → `cloud-routine`
- otherwise → `desktop-task`

Print a table:

```
Canon Routines
--------------
name              status    binding        trigger
my-nightly-check  enabled   cloud-routine  schedule(0 2 * * *)
pr-reviewer       disabled  desktop-task   github-event(pull_request)
```

If no routines found: print `No routines found. Add .md files to .canon/routines/ or the plugin routines/ directory.`

### enable <name>

1. Find the routine file by name (check `.canon/routines/<name>.md` first, then plugin).
2. Read the file content.
3. Replace `status: disabled` or `status: draft` with `status: enabled` in the YAML frontmatter.
4. Write the updated file.
5. Regenerate `routines/.claude/CLAUDE.md` index (call `generateRoutinesIndex` from `mcp-server/src/features/routines/services/routine-index.ts` — or reproduce the table inline if MCP not available).
6. Print: `Enabled: <name>`

Note: enabling does NOT sync the binding. Run `/canon:routines sync <name>` to create the SKILL.md or emit the recipe.

### disable <name>

1. Find the routine file by name.
2. Replace `status: enabled` with `status: disabled` in the YAML frontmatter.
3. Write the updated file.
4. Regenerate the index.
5. Print: `Disabled: <name>`

Note: disabling does NOT remove the live binding. Run `/canon:routines delete <name>` to remove the artifact and binding.

### delete <name>

1. Find the routine file by name.
2. Determine its binding target.
3. If `desktop-task`: check if `~/.claude/scheduled-tasks/<name>/SKILL.md` exists and, if so, prompt the user:
   "This will remove the routine artifact. The SKILL.md at `~/.claude/scheduled-tasks/<name>/SKILL.md` will also be removed. Continue? (y/n)"
   On confirmation: remove both the artifact file and the SKILL.md.
   On decline: abort.
4. If `cloud-routine`: remove only the artifact file; print a reminder that the cloud recipe must be deleted manually from the scheduling platform.
5. Regenerate the index.
6. Print: `Deleted: <name>`

### sync [<name>]

**This is the ONLY path that calls sync emitters / writes SKILL.md / emits recipes.**

Call the `sync_routines` MCP tool (`mcp__canon__sync_routines`) — it is the single runtime write path for SKILL.md files and cloud recipes. Pass `name` for a single routine; omit to sync all enabled routines.

#### sync <name> (single routine)

1. Call `mcp__canon__sync_routines({ name: "<name>" })`.
2. If `kind: "desktop"`: print `Written: <path>`.
3. If `kind: "recipe"`: print the recipe text and: "Copy the recipe above and register it on your scheduling platform."

#### sync (all enabled routines)

1. Call `mcp__canon__sync_routines({})` (no `name` — syncs all enabled routines in parallel).
2. Print a summary: `Synced N routine(s).` followed by per-routine status lines (name + kind).

## Step 3: Present Results

After any subcommand:
- On success: print the result as described above.
- On error (file not found, write failure): print `Error: <message>` and exit with a non-zero status.
- Always print the final state of the affected routine(s) after enable/disable/sync.

## Integration

To check drift (is any enabled routine unbound?) run `/canon:routines list` and look for `enabled` routines whose live binding is missing. To fix: run `/canon:routines sync <name>`.
