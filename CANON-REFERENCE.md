# Canon Reference

<!-- Lookup tables for agents. The orchestrator doesn't need this — behavioral rules are in CLAUDE.md. -->

## Project Structure

```
canon/
├── agents/               # Agent definitions (YAML frontmatter + markdown instructions)
├── flows/                # Flow state machine definitions (YAML frontmatter + spawn instructions)
│   └── fragments/        # Reusable state groups included by flows
├── hooks/                # Pre/post tool-use interceptor scripts + hooks.json registry
├── mcp-server/           # TypeScript MCP server (Canon harness tools)
│   └── src/
│       ├── orchestration/  # Flow runtime: board, bulletin, convergence, events, gate-runner, etc.
│       ├── tools/          # MCP tool implementations (one file per tool)
│       ├── drift/          # JSONL-backed drift tracking (decisions, patterns, reviews)
│       └── graph/          # Dependency graph scanner and priority scoring
├── principles/           # Canonical engineering principles (markdown)
├── skills/canon/         # Canon skill definition (entry point for Cursor/Claude Code)
│   └── references/       # Skill reference fragments loaded on demand
├── templates/            # Artifact templates agents must follow
├── mcp-server/ui/        # Svelte/Sigma.js dashboard UI (builds to single HTML for MCP App)
├── commands/             # CLI command definitions
└── .canon/               # Runtime data (workspaces, principles, config, drift JSONL)
    └── workspaces/       # Per-branch/task build state (board.json, session.json, progress.md, plans/, etc.)
```

## Flows

Flows are state machines in `flows/`. Format: YAML frontmatter (states, transitions, constraints) + markdown spawn instructions. See `flows/SCHEMA.md` for the full schema.

| Flow | Tier | Purpose |
|------|------|---------|
| `hotfix` | Small (urgent) | Emergency fix — minimal ceremony, implement → verify → ship |
| `quick-fix` | Small | Bug fix or minor addition (1-3 files) |
| `refactor` | Medium | Behavior-preserving restructuring with continuous test verification |
| `feature` | Medium | New feature pipeline (4-10 files) |
| `migrate` | Medium | Staged migration with rollback planning and verification |
| `deep-build` | Large | Research → design → wave implementation → test → security → review (10+ files) |
| `explore` | Research | Investigate a codebase question — no implementation |
| `test-gap` | Testing | Analyze coverage gaps, write tests, verify, review |
| `review-only` | Review | Review an existing PR or branch without implementing |
| `security-audit` | Security | Dedicated security audit |
| `adopt` | Adoption | Scan for principle violations and auto-fix |

**Flow Fragments** (`flows/fragments/`) — Reusable state groups included into flows via `includes:`:
`context-sync`, `test-fix-loop`, `review-fix-loop`, `implement-verify`, `verify-fix-loop`, `security-scan`, `user-checkpoint`, `plan-review`, `pattern-check`, `early-scan`, `impl-handoff`, `ship-done`

**State types**: `single` (one agent), `parallel` (concurrent agents), `wave` (parallel agents in git worktrees with gates between waves), `parallel-per` (fan-out over items from prior state), `terminal`.

**State `effects:` field** — Optional list of drift extraction operations that run automatically after a state completes. Declared on the state definition in fragment or flow YAML, sibling to `transitions:`. Effect types:
- `persist_decisions` — extracts JUSTIFIED_DEVIATION entries from agent summaries into drift store (active on `implement` and `ship` states)
- `persist_patterns` — extracts observed patterns from agent summaries into drift store (active on `ship` state)
- `persist_review` — stores a reviewer artifact file into drift store; requires `artifact:` field naming the file (active on `review` state, artifact: `REVIEW.md`)

## MCP Tools (Harness)

The Canon MCP server exposes these tools. Orchestrator uses the harness tools to drive flows; specialist agents use the principle and drift tools. Tools with UIs open as MCP Apps in compatible clients (Claude Desktop).

**Tools with MCP App UIs:**

| Tool | Purpose |
|------|---------|
| `show_pr_impact` | PR blast radius, hotspots, violations, dependency subgraph |
| `codebase_graph` | Interactive dependency graph with compliance overlay |
| `get_drift_report` | Full drift analysis (violations, trends, hotspots, PR reviews) |
| `get_compliance` | Per-principle compliance stats, weekly trend chart |
| `get_file_context` | File dependencies, entities, blast radius, metrics |
| `get_pr_review_data` | PR file list by layer, priority scores, diff metadata |
| `graph_query` | Call trees, blast radius, dead code, search |

**Principle & review tools:**

| Tool | Purpose |
|------|---------|
| `get_principles` | Find applicable principles for a file/layer/task |
| `list_principles` | Browse principle index (metadata only) |
| `review_code` | Surface principles matched to a specific file for review |
| `report` | Log a decision, pattern, or review result (drift tracking) |
| `store_summaries` | Persist file summaries to `.canon/summaries.json` |
| `get_decisions` | Grouped intentional deviation decisions |
| `get_patterns` | Observed codebase patterns (grouped, deduplicated) |
| `store_pr_review` | Store a PR review result for drift tracking |

**Orchestration harness tools:**

| Tool | Purpose |
|------|---------|
| `load_flow` | Load and resolve a flow definition (fragments, spawn instructions, state graph) |
| `validate_flows` | Validate flow definitions (parse, fragment resolution, reachability) |
| `init_workspace` | Create or resume a workspace (`board.json`, `session.json`, `progress.md`); seeds `progress.md` with task header on creation |
| `update_board` | Mutate board state: enter/skip/block/unblock states, complete flow, set wave progress |
| `get_spawn_prompt` | Resolve spawn prompt for a state (variable substitution, overlays, wave context); reads `progress.md` from disk and injects as `${progress}` when flow declares `progress:` field |
| `report_result` | Record agent result, evaluate transitions, check stuck detection; returns `next_state` |
| `check_convergence` | Check iteration limits before re-entering a looping state |
| `list_overlays` | List available role overlays (expertise lenses injected into prompts) |
| `post_wave_bulletin` | Post inter-agent message during parallel wave execution |
| `get_wave_bulletin` | Read wave bulletin messages from other agents in the same wave |
| `inject_wave_event` | Inject user events into running wave execution |
| `get_flow_analytics` | Flow execution analytics and bottleneck identification |

## Canon Engineering Principles

This project uses Canon for engineering principles. Before writing or modifying code, load relevant principles via the `get_principles` MCP tool. Principles are in `.canon/principles/`. Severity levels: `rule` is non-negotiable, `strong-opinion` requires justification to skip, `convention` is noted but doesn't block.

## Hooks

`hooks/hooks.json` registers pre/post tool-use interceptors that run automatically. Key hooks: `destructive-guard.sh` (blocks dangerous git ops), `workspace-lock-guard.sh` (prevents concurrent builds), `pre-commit-check.sh` (secrets + compliance), `principle-inject.sh` (injects principle summaries into prompts), `agent-cost-tracker.sh` (tracks API costs). See `hooks/.claude/CLAUDE.md` for the full registry.
