# Canon Plugin — Target Repository Structure

This document defines the target directory layout for the Canon plugin, aligned with
Claude Code's native conventions for plugins as documented in the
[Plugins Reference](https://code.claude.com/docs/en/plugins-reference#plugin-directory-structure).

## Design Principles

1. **Use Claude Code's native plugin structure** — plugin agents live in `agents/` at the
   plugin root (gaining the `canon:` prefix), hooks in `hooks/`, skills in `skills/`.
   Default plugin settings live in root `settings.json`.
2. **Plugin content is at the plugin root** — Canon is a Claude Code plugin. Its agents
   live in `agents/`, commands in `commands/` (legacy) or `skills/`, and hooks in `hooks/`
   at the plugin root. Don't invent parallel directories.
3. **`rules/` is NOT a plugin convention** — the official plugin reference does not include
   `rules/` as a plugin component. Claude Code auto-discovers `rules/` only in `.claude/`
   for project-scoped rules, not at the plugin root. Universal agent rules must be
   delivered via an alternative mechanism (e.g., inlined into agent prompts, injected via
   hooks, or bundled into CLAUDE.md content).
4. **MCP server is the runtime** — `mcp-server/` contains all TypeScript source. Its
   internal structure uses feature-sliced design (`shared/`, `platform/`, `features/`,
   `domains/`).
5. **Content directories are plugin assets** — `principles/`, `flows/`, `templates/`,
   `domain-primers/` are markdown/YAML assets read by the MCP server at runtime. They
   stay at the plugin root.
6. **No name collisions across layers** — a directory name should mean one thing. If
   both the plugin root and `mcp-server/src/` need a concept, disambiguate the names.

## Official Plugin Components Reference

From the [Plugins Reference](https://code.claude.com/docs/en/plugins-reference):

| Component        | Default Location             | Purpose                                              |
|------------------|------------------------------|------------------------------------------------------|
| **Manifest**     | `.claude-plugin/plugin.json` | Plugin metadata and configuration (optional)         |
| **Commands**     | `commands/`                  | Markdown command files (legacy; use `skills/` for new)|
| **Agents**       | `agents/`                    | Subagent Markdown files                              |
| **Skills**       | `skills/`                    | Skills with `<name>/SKILL.md` structure              |
| **Output styles**| `output-styles/`             | Output style definitions                             |
| **Hooks**        | `hooks/hooks.json`           | Hook configuration (+ additional JSON files)         |
| **MCP servers**  | `.mcp.json`                  | MCP server definitions                               |
| **LSP servers**  | `.lsp.json`                  | Language server configurations                       |
| **Executables**  | `bin/`                       | Executables added to Bash tool's PATH                |
| **Settings**     | `settings.json`              | Default config applied when plugin is enabled        |

**NOT official plugin conventions** (project-level only):
- `rules/` — project-scoped rules live in `.claude/rules/`, not at plugin root
- `.claude/CLAUDE.md` — project-level instructions, not plugin content

**Environment variables** available in plugin contexts:
- `${CLAUDE_PLUGIN_ROOT}` — absolute path to plugin installation directory
- `${CLAUDE_PLUGIN_DATA}` — persistent directory for plugin state (survives updates)

## Target Structure

```
canon/                                    # plugin root (git root)
│
├── .claude-plugin/
│   └── plugin.json                       # plugin manifest (optional but recommended)
│
├── .claude/
│   ├── CLAUDE.md                         # project-scoped orchestrator instructions
│   │                                     #   (not a plugin convention — for dev/consuming projects)
│   └── settings.json                     # project-scoped settings
│
├── agents/                               # specialist agent definitions (canon: prefix)
│   ├── architect.md
│   ├── chat.md
│   ├── fixer.md
│   ├── canon-generalist.md
│   ├── guide.md
│   ├── implementor.md
│   ├── learner.md
│   ├── researcher.md
│   ├── reviewer.md
│   ├── scribe.md
│   ├── security.md
│   ├── shipper.md
│   ├── tester.md
│   └── writer.md
│
├── commands/                             # legacy command location (auto-discovered)
│   ├── check.md                          #   kept at root per plugin convention
│   ├── clean.md                          #   (official default: commands/ at plugin root)
│   ├── doctor.md
│   ├── edit-principle.md
│   ├── init.md
│   ├── learn.md
│   ├── pr-review.md
│   └── test-principle.md
│
├── skills/
│   └── canon/
│       ├── SKILL.md                      # skill entry point
│       ├── evals/                        # skill evaluations
│       └── references/                   # skill reference docs
│
├── output-styles/                        # output style definitions (plugin convention)
│   └── (future: terse.md, verbose.md, etc.)
│
├── flows/                                # orchestration flow definitions (YAML + md)
│   ├── SCHEMA.md                         # flow schema reference
│   ├── GATES.md                          # gate definitions
│   ├── epic.md
│   ├── feature.md
│   ├── fast-path.md
│   ├── explore.md
│   ├── refactor.md
│   ├── migrate.md
│   ├── review-only.md
│   ├── security-audit.md
│   ├── test-gap.md
│   ├── adopt.md
│   └── fragments/                        # reusable flow fragments
│       ├── context-sync.md
│       ├── early-scan.md
│       ├── impl-handoff.md
│       ├── implement-verify.md
│       ├── pattern-check.md
│       ├── plan-review.md
│       ├── review-fix-loop.md
│       ├── security-scan.md
│       ├── ship-done.md
│       ├── targeted-research.md
│       ├── test-fix-loop.md
│       ├── user-checkpoint.md
│       └── verify-fix-loop.md
│
├── principles/                           # engineering principles (plugin content)
│   ├── conventions/                      # 17 convention files
│   ├── rules/                            # 4 rule files
│   └── strong-opinions/                  # 33 strong opinion files
│
├── templates/                            # prompt/report templates
│   ├── chat-brief.md
│   ├── design-document.md
│   ├── plan-index.md
│   ├── pr-description.md
│   ├── research-finding.md
│   ├── review-checklist.md
│   ├── security-assessment.md
│   ├── task-plan.md
│   ├── test-report.md
│   ├── wave-briefing.md
│   └── ...
│
├── domain-primers/                       # domain primers for context injection
│   ├── backend-api.md                    #   renamed from domains/ to avoid collision
│   ├── backend-data.md                   #   with mcp-server/src/domains/
│   ├── frontend.md
│   ├── infrastructure.md
│   └── testing.md
│
├── hooks/                                # Claude Code hook implementations
│   ├── hooks.json                        #   main hook config (plugin convention)
│   ├── compaction-check.sh               #   hook scripts referenced by hooks.json
│   ├── destructive-guard.sh
│   ├── large-file-guard.sh
│   ├── learn-nudge.sh
│   ├── plan-mode-guard.sh
│   ├── pre-commit-check.sh
│   ├── pre-push-review.sh
│   ├── principle-inject.sh
│   ├── principle-inject-worker.mjs
│   └── workspace-lock-guard.sh
│
├── scripts/                              # hook and utility scripts
│   ├── baseline-orientation-metrics.sh
│   └── release.sh
│
├── bin/                                  # plugin executables added to Bash PATH
│   └── (future: CLI tools for Canon)     #   invokable as bare commands when plugin is enabled
│
├── docs/                                 # documentation (non-runtime)
│   ├── reference/
│   │   └── canon-reference.md            # currently CANON-REFERENCE.md
│   ├── adr/                              # architecture decision records
│   └── images/                           # currently images/
│
├── CLAUDE.md                             # root CLAUDE.md — project instructions for
│                                         #   consuming projects (merged with .claude/CLAUDE.md)
├── README.md
├── LICENSE
├── CHANGELOG.md                          # version history (plugin convention)
├── settings.json                         # plugin default settings (applied on enable)
├── .mcp.json                             # MCP server definitions
├── .lsp.json                             # LSP server configurations (future)
├── .gitignore
├── .gitattributes
├── .tool-versions
│
└── mcp-server/                           # MCP server (npm package)
    ├── package.json
    ├── tsconfig.json
    ├── biome.json
    ├── grammars/                          # tree-sitter WASM files
    │
    └── src/
        ├── app/
        │   └── index.ts                  # entrypoint — tool registration, server bootstrap
        │
        ├── shared/                       # cross-cutting utilities (no feature deps)
        │   ├── *.ts                      #   constants, schema, parser, matcher
        │   ├── lib/                      #   pure helpers (env, paths, errors, etc.)
        │   └── ui/                       #   shared Svelte primitives (base.css, stores, components)
        │
        ├── platform/                     # infrastructure adapters (no feature deps)
        │   ├── adapters/                 #   git/, process/, jobs/
        │   ├── storage/                  #   drift persistence
        │   ├── workers/                  #   background graph worker
        │   └── jobs/                     #   job definitions
        │
        ├── domains/                      # domain models (pure data, no tools, no UI)
        │   ├── board/                    #   board state + sync
        │   ├── flows/                    #   flow schema, parser, gates, skip-when
        │   ├── messages/                 #   events, variables, event bus
        │   └── workspaces/              #   workspace, waves, execution state
        │
        └── features/                     # feature slices (each: tools/ + services/ + ui/)
            ├── orchestration/            #   engine/ (transitions, effects, convergence,
            │                             #     compete, debate, consultations)
            │                             #   services/ (context, scope, wave resolution)
            │                             #   tools/ (drive-flow, init-workspace, load-flow,
            │                             #     report-result, update-board, write-*)
            ├── knowledge-graph/          #   model/, services/, ingestion/, adapters/, tools/
            ├── prompt-pipeline/          #   model/, services/, tools/
            ├── pr-review/                #   services/, ui/
            ├── codebase-graph/           #   ui/ only (tools live in knowledge-graph)
            ├── file-context/             #   services/, ui/
            ├── principles/               #   services/ (get, list, compliance)
            └── diagnostics/              #   services/ (failures, drift, convergence, metrics)
```

## Key Decisions

### 1. `rules/` is NOT a plugin convention — universal rules inlined into agents

The [official plugin reference](https://code.claude.com/docs/en/plugins-reference#file-locations-reference)
does not list `rules/` as a plugin component. Claude Code auto-discovers `rules/` only
under `.claude/` for project-scoped rules — not at the plugin root.

This means the original plan to put 4 universal rules in `rules/` at plugin root would
not work. Instead, **all 18 agent-rules are inlined into their target agent `.md` files**.

For rules that apply to every agent (template-required, workspace-scoping,
missing-artifact, convergence-discipline), the content is inlined into each agent that
needs it. This adds some duplication but eliminates reliance on a mechanism that doesn't
exist in the plugin system.

**All rules -> inlined into their target subagent `.md` files:**

| Rule | Target subagent(s) |
|------|--------------------|
| `template-required` | All agents that produce output |
| `workspace-scoping` | All agents |
| `missing-artifact` | All agents |
| `convergence-discipline` | All agents |
| `artifacts-only` | shipper |
| `assume-hostile-input` | security |
| `cold-review` | reviewer |
| `conflict-detection` | writer |
| `context-sync` | scribe |
| `design-before-code` | architect |
| `evidence-over-intuition` | learner |
| `fresh-context` | implementor |
| `minimal-fix` | fixer |
| `plans-are-prompts` | architect |
| `scoped-research` | researcher |
| `tdd-required` | implementor |
| `test-sad-paths` | tester, implementor |
| `test-the-contract` | tester |

**Alternative delivery mechanisms** (if duplication becomes untenable):
- Hook-based injection: Use a `SubagentStart` hook to prepend universal rules into agent context
- CLAUDE.md inclusion: Put universal rules in root CLAUDE.md (inherited by all agents)
- `settings.json` agent settings: Plugin `settings.json` supports agent configuration

### 2. `agents/` stays at plugin root

Plugin agents live in `agents/` at the plugin root. This gives them the `canon:` prefix
for `subagent_type` (e.g., `canon:implementor`).

`canon-orchestrator.md` does NOT move to agents — it's not a spawnable subagent.
Its content belongs in `.claude/CLAUDE.md` or root `CLAUDE.md`.

### 3. `commands/` stays at plugin root (legacy but auto-discovered)

The official plugin reference lists `commands/` as a default location at plugin root.
It's marked as legacy (prefer `skills/` for new work), but is still auto-discovered.

**Changed from original plan**: Commands stay in `commands/` at root instead of moving
to `skills/canon/commands/`. The skill's `SKILL.md` dispatches to them; references in
`skills/canon/references/` provide supporting docs.

### 4. `AGENTS.md` -> removed

Claude Code does not read `AGENTS.md`. Remove it or move to `docs/reference/`.

### 5. `CLAUDE.md` placement

Both root `CLAUDE.md` and `.claude/CLAUDE.md` are read and merged by Claude Code.
Neither is a plugin convention per se — they're project-level instructions.

Recommendation: Root `CLAUDE.md` as lightweight project overview for consuming projects.
`.claude/CLAUDE.md` for the orchestrator protocol (development instructions).

### 6. `settings.json` at plugin root (NEW)

The official plugin convention includes `settings.json` at the plugin root for default
configuration applied when the plugin is enabled. Currently only `agent` settings are
supported. This is distinct from `.claude/settings.json` (project-scoped settings).

### 7. Content directories stay at plugin root

`principles/`, `flows/`, `templates/`, `hooks/` are plugin content assets read by the
MCP server at runtime via file paths. They don't map to any Claude Code convention and
stay at the plugin root.

### 8. `domains/` -> `domain-primers/`

Rename plugin-root `domains/` to `domain-primers/` to avoid collision with
`mcp-server/src/domains/`.

### 9. `hooks/hooks.json` is the default hook config location

Per the official docs, `hooks/hooks.json` is the default hook configuration file for
plugins. Additional hook JSON files can coexist in `hooks/` (e.g., `security-hooks.json`).

Hook scripts should use `${CLAUDE_PLUGIN_ROOT}` for paths:
```json
{
  "type": "command",
  "command": "${CLAUDE_PLUGIN_ROOT}/hooks/principle-inject.sh"
}
```

**Supported hook types**: `command`, `http`, `prompt`, `agent`

### 10. `bin/` for plugin executables (NEW)

The official plugin convention includes `bin/` for executables that are added to the
Bash tool's PATH when the plugin is enabled. Files here are invokable as bare commands.
Reserved for future Canon CLI tools.

### 11. `output-styles/` for output formatting (NEW)

The official plugin convention includes `output-styles/` for output style definitions.
Reserved for future Canon output styles (e.g., terse reports, verbose debugging).

### 12. `.lsp.json` for language server configs (NEW)

Plugins can bundle LSP server configurations. Not needed for Canon currently but the
file location is reserved at plugin root.

### 13. Plugin manifest expanded fields

The `plugin.json` schema now supports:
- `userConfig` — values prompted at enable time (API keys, endpoints)
- `channels` — message channel declarations (Telegram, Slack, Discord style)
- `lspServers` — LSP configurations
- `outputStyles` — output style paths
- `bin` — executable paths

### 14. `.ai/` removed after migration

`.ai/` contains planning artifacts used during the migration. Remove after all phases
complete.

### 15. Plugin component discovery vs. MCP tool registration are separate mechanisms

There are two distinct discovery/registration mechanisms that coexist in Canon. Understanding
the difference prevents confusion when reading the directory structure.

**Plugin component auto-discovery (Claude Code, filesystem-based)**

Claude Code scans the plugin root filesystem at enable/load time and auto-discovers:

| Directory | What Claude Code discovers |
|-----------|---------------------------|
| `agents/` | Subagent `.md` files → registered with `canon:` prefix |
| `commands/` | Command `.md` files → registered as slash commands |
| `skills/` | Skill directories with `SKILL.md` → registered as skills |
| `hooks/` | `hooks.json` config → hooks registered for lifecycle events |
| `bin/` | Executables → added to Bash tool's PATH |
| `output-styles/` | Output style definitions → registered as style options |

These are pure filesystem paths. Claude Code reads them directly; no TypeScript, no
server process, no registration code is involved.

**MCP tool registration (runtime, server-process-based)**

MCP tools (`drive_flow`, `init_workspace`, `load_flow`, `report_result`, `update_board`,
`review_code`, `get_principles`, `record_agent_metrics`, etc.) are **not** auto-discovered
from the filesystem. They are:

1. **Defined in TypeScript** under `mcp-server/src/features/*/tools/` — each tool is a
   handler registered programmatically when the MCP server starts.
2. **Served by the MCP server process** — a Node.js process started per `.mcp.json`.
3. **Configured via `.mcp.json`** at the plugin root — this tells Claude Code how to
   launch the MCP server and what to call it.

The `tools/` directories inside `mcp-server/src/features/` are **internal MCP server
source code**, not plugin convention paths. They have nothing to do with Claude Code's
filesystem scanning.

**Summary: two layers, one plugin**

```
Plugin root (filesystem scanning by Claude Code)
  agents/        → subagents
  commands/      → slash commands
  skills/        → skills
  hooks/         → lifecycle hooks
  bin/           → PATH executables
  output-styles/ → output styles
  .mcp.json      → "launch this MCP server process"

MCP server process (runtime, programmatic registration)
  mcp-server/src/features/*/tools/  → tool handlers registered at startup
  mcp-server/src/app/index.ts       → entrypoint that registers all tools
```

When a user runs a Canon MCP tool (e.g., `drive_flow`), Claude Code routes the call to
the MCP server process — not to any filesystem path. When Claude Code discovers a Canon
agent (e.g., `canon:implementor`), it reads `agents/implementor.md` directly
from the filesystem — no MCP server involved.

## What Gets Removed

| Current | Reason |
|---------|--------|
| `agent-rules/` | All rules inlined into target agent `.md` files |
| `rules/` (planned) | NOT a plugin convention — rules inlined into agents instead |
| `commands/` | **KEPT** — legacy but auto-discovered plugin convention |
| `domains/` | Renamed to `domain-primers/` to avoid collision |
| `AGENTS.md` | Claude Code doesn't read it |
| `CANON-REFERENCE.md` (root) | Moves to `docs/reference/` |
| `context.md` (root) | Ephemeral workspace artifact — gitignore or move to docs |
| `images/` (root) | Moves to `docs/images/` |
| `.ai/` | Planning artifacts — removed after migration completes |

## What Gets Added

| New | Reason |
|-----|--------|
| `settings.json` (root) | Plugin default settings (official convention) |
| `CHANGELOG.md` | Version history (official convention) |
| `.lsp.json` | LSP server configs — reserved for future |
| `bin/` | Plugin executables added to PATH — reserved for future |
| `output-styles/` | Output style definitions — reserved for future |

## Migration Phases

Phases 1-2 (plugin layout) and Phases 3-6 (MCP server) are independent tracks.
They can be parallelized or sequenced in either order. Within each track, phases
are sequential.

### Phase 0: Plugin manifest setup (complete)
- Create/update `.claude-plugin/plugin.json` with expanded schema fields
- Create root `settings.json` for plugin default settings
- Reserve `bin/`, `output-styles/`, `.lsp.json` (empty/placeholder)

### Phase 1: Agent alignment (complete)
- Inline ALL 18 agent-rules into their target subagent `.md` files:
  - 4 universal rules (template-required, workspace-scoping, missing-artifact,
    convergence-discipline) → inlined into every agent that needs them
  - 14 scoped rules → inlined into their specific target agents (see Decision 1 table)
- Remove `agent-rules/` directory after all content is migrated
- Keep `agents/canon-*.md` at plugin root `agents/`
- Merge `agents/canon-orchestrator.md` content into `.claude/CLAUDE.md`
- Remove `AGENTS.md`
- Keep `commands/*.md` at plugin root `commands/` (legacy auto-discovered)
- Update `SKILL.md` to reference commands at root `commands/` path
- Rename `domains/` -> `domain-primers/`
- Ensure `hooks/hooks.json` exists with correct config
- Update hook scripts to use `${CLAUDE_PLUGIN_ROOT}` for paths
- Update references in `SKILL.md`, `CLAUDE.md`, hook scripts, and agent prompt files
  Note: do NOT update MCP server import paths here — those change in Phases 3-5

### Phase 2: Root docs cleanup (complete)
- `CANON-REFERENCE.md` -> `docs/reference/canon-reference.md`
- `images/` -> `docs/images/`
- Remove or gitignore `context.md`
- Update README.md image paths
- Add `CHANGELOG.md`

### Phase 3: MCP server — shared & platform extraction (complete)
Move `src/{constants,schema,parser,matcher}.ts` -> `src/shared/`
Move `src/utils/*` -> `src/shared/lib/`
Move `src/adapters/*` -> `src/platform/adapters/`
Move `src/drift/*` -> `src/platform/storage/drift/`
Move `src/jobs/*`, `src/workers/*` -> `src/platform/`

### Phase 4: MCP server — feature slicing (in progress)
Move `src/graph/*` -> `src/features/knowledge-graph/`
Move `src/tools/prompt-pipeline/*` -> `src/features/prompt-pipeline/`
Move `src/ui/*` -> split across `src/features/{pr-review,codebase-graph,file-context}/ui/` + `src/shared/ui/`

### Phase 5: MCP server — orchestration & domains
Move `src/orchestration/*` -> split across `src/domains/` and `src/features/orchestration/`
Move remaining `src/tools/*` -> respective `src/features/*/tools/` or `services/`
Create `src/app/index.ts` as new entrypoint

### Phase 6: Test colocation
Move `__tests__/` files to colocated `__tests__/` dirs within their feature/domain.
Shared test helpers -> `tests/helpers/`.

### Phase 7: Cleanup
- Remove `.ai/` directory (planning artifacts no longer needed)
- Remove any empty `rules/` directory if it was created
- Final stale-reference sweep across all phases

## Validation

Each phase must pass:
1. `cd mcp-server && npm run build` — no new compilation errors
2. `npm test` — no new test failures beyond documented baseline (32 pre-existing)
3. `grep -r` for stale import paths — no references to old locations
4. Plugin still loads in Claude Code — `SKILL.md` entry point works
5. `claude --debug` — plugin components discovered correctly
