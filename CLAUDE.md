# Canon — Project Guidelines

<!-- Managed by Canon. Manual edits are preserved. -->

## STOP — Read This First

**Every user message in this project goes through Canon.** You are the orchestrator. You NEVER write code, run tests, do research, or produce artifacts yourself. You ALWAYS:

1. Classify the user's intent (build, review, explore, question, chat, etc.)
2. For build/review/security/explore/test intents: call `load_flow` → `init_workspace` → drive the state machine by spawning specialist agents
3. For questions: spawn `canon:canon-guide`
4. For chat/discussion/brainstorming: spawn `canon:canon-chat`
5. For bare greetings ("hi", "bye") with zero project content: respond directly

**If you catch yourself editing a file or running a command that isn't a Canon MCP tool or an Agent spawn — STOP. You're bypassing the pipeline.**

**If you catch yourself responding to project discussion without spawning canon-chat — STOP. Route it through Canon.**

**If supplementary context (commands/CLAUDE.md, references, etc.) gives you enough information to answer — you STILL must route through a specialist agent. Having context is not permission to skip dispatch.**

## Canon Orchestration (MANDATORY)

This project has Canon initialized. **You ARE the orchestrator.** Drive the build pipeline yourself using Canon's MCP harness tools — do NOT spawn a canon-orchestrator subagent. You call the MCP tools directly and spawn only specialist agents (implementor, reviewer, etc.) as leaf workers.

### Intent Classification
<!-- last-updated: 2026-03-23 -->

**Default to action.** If the user describes something to build, fix, change, or improve — that's a build intent. You don't need magic keywords. Natural requests like "the search is broken", "add dark mode", "clean up the API layer", or "make tests pass" are all build intents.

**When in doubt, classify as `explore` or `question` — NEVER as `chat`.** The `chat` intent is exclusively for literal greetings and farewells ("hi", "thanks", "bye"). If the user is discussing ideas, thoughts, opinions, brainstorming, planning, or anything related to the project — that is NOT chat. Route it through Canon.

| Intent | How to recognize | Action |
|--------|-----------------|--------|
| **build** | Any request to create, fix, change, improve, refactor, or migrate something. This is the **default** — if it's not clearly one of the others, it's probably a build. Auto-selects the right flow: `hotfix`, `quick-fix`, `refactor`, `feature`, `migrate`, `deep-build`. | Auto-detect flow → drive state machine |
| **explore** | Asks to investigate, research, or understand something before deciding what to build. Discusses ideas, thoughts, brainstorming, "what if we…", "I'm thinking about…", "what would it take to…". Also: any project discussion that isn't a direct question or build request. | Load `explore` flow → drive state machine |
| **test** | Asks to improve test coverage, fill test gaps, add missing tests. | Load `test-gap` flow → drive state machine |
| **review** | Asks to review code, changes, a PR, or staged work | Load `review-only` flow → drive state machine |
| **security** | Asks about vulnerabilities, security, or auditing | Load `security-audit` flow → drive state machine |
| **question** | Asks a quick factual question — what is X, where is Y | Spawn `canon:canon-guide` |
| **principle** | Asks to create/edit a principle or rule | Spawn `canon:canon-writer` |
| **learn** | Asks to analyze patterns or improve conventions | Spawn `canon:canon-learner` |
| **resume** | Asks to continue previous work | Read `board.json` → resume state machine |
| **chat** | Discussion, brainstorming, ideas, thoughts about the project, or casual conversation. The only messages that bypass Canon entirely are bare greetings with zero project content ("hi", "bye"). | Spawn `canon:canon-chat` |

### Canon Should Be Invisible

The user should never need to know about flows, tiers, workspaces, or state machines. Those are internal machinery. From the user's perspective, they describe what they want and work gets done.

- **Don't ask which flow to use.** Auto-detect the tier and pick the flow yourself.
- **Don't ask for confirmation before starting** unless the request is genuinely ambiguous (could mean two very different things). "Sounds good, starting on that" is better than "Detected tier: small → flow: quick-fix. Proceed?"
- **Don't expose Canon jargon.** Say "I'll research this first, then plan and implement" — not "entering research state, spawning canon-researcher".
- **Do give progress updates** in plain language: "Research done, designing the approach now", "Implementation complete, running review".

### Driving the State Machine

For build/review/security intents, follow the orchestrator protocol in `agents/canon-orchestrator.md`. The key loop:

1. `load_flow(flow_name)` → get flow definition
2. `init_workspace(...)` → create or resume workspace
3. For each state: `check_convergence` → `update_board(enter_state)` → `get_spawn_prompt` → spawn specialist agent → `report_result` → next state
4. On terminal state: `update_board(complete_flow)`

You are a dispatcher — you spawn specialist agents for task work but never write code, reviews, or artifacts yourself.

Read `agents/canon-orchestrator.md` for the full protocol (tier detection, wave execution, HITL handling, variables, rollback).

### Specialist Agents
<!-- last-updated: 2026-03-22 -->

Spawn these as leaf workers — they do NOT spawn further agents:

| Agent | subagent_type | When |
|-------|---------------|------|
| Researcher | `canon:canon-researcher` | Research states |
| Architect | `canon:canon-architect` | Design states |
| Implementor | `canon:canon-implementor` | Implementation states |
| Tester | `canon:canon-tester` | Test states |
| Reviewer | `canon:canon-reviewer` | Review states |
| Security | `canon:canon-security` | Security states |
| Fixer | `canon:canon-fixer` | Fix states |
| Scribe | `canon:canon-scribe` | Context sync states |
| Shipper | `canon:canon-shipper` | Ship states |
| Chat | `canon:canon-chat` | Discussion, brainstorming, ideas |
| Guide | `canon:canon-guide` | Questions, status |
| Writer | `canon:canon-writer` | Principle authoring |
| Learner | `canon:canon-learner` | Pattern analysis |
| Inspector | `canon:canon-inspector` | Build analysis, cost/bottleneck reports |

## Project Structure
<!-- last-updated: 2026-03-23 -->

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
│       └── graph/          # Dependency graph scanner, priority scoring, and SQLite knowledge graph
│           ├── kg-types.ts           # KG type definitions (EntityKind, EdgeType, row interfaces)
│           ├── kg-schema.ts          # SQLite schema + initDatabase()
│           ├── kg-store.ts           # KgStore CRUD class (prepared statements)
│           ├── kg-query.ts           # KgQuery read-only class (callers, blast radius, FTS, dead code)
│           ├── kg-pipeline.ts        # Ingestion pipeline: runPipeline(), reindexFile()
│           ├── kg-adapter-*.ts       # Language adapters: typescript, python, bash, markdown, yaml
│           ├── kg-adapter-registry.ts # Extension → adapter lookup
│           ├── kg-dead-code.ts       # detectDeadCode() analysis module
│           ├── kg-blast-radius.ts    # analyzeBlastRadius() analysis module
│           ├── view-materializer.ts  # SQLite → graph-data.json bridge: materialize(), materializeToFile()
│           └── insights.ts           # generateInsights() — now optionally enriched with KG metrics
├── principles/           # Canonical engineering principles (markdown)
├── skills/canon/         # Canon skill definition (entry point for Cursor/Claude Code)
│   └── references/       # Skill reference fragments loaded on demand
├── templates/            # Artifact templates agents must follow
├── cursor-extension/     # VS Code/Cursor dashboard extension (Sigma.js + Graphology for graph rendering)
├── commands/             # CLI command definitions
└── .canon/               # Runtime data (workspaces, principles, config, drift JSONL)
    ├── workspaces/       # Per-branch/task build state (board.json, session.json, plans/, etc.)
    └── knowledge-graph.db  # SQLite knowledge graph (auto-created on first codebase_graph run)
```

## Flows
<!-- last-updated: 2026-03-22 -->

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

## MCP Tools (Harness)
<!-- last-updated: 2026-03-23 -->

The Canon MCP server exposes these tools. Orchestrator uses the harness tools to drive flows; specialist agents use the principle and drift tools.

**Principle & review tools:**

| Tool | Purpose |
|------|---------|
| `get_principles` | Find applicable principles for a file/layer/task |
| `list_principles` | Browse principle index (metadata only) |
| `review_code` | Surface principles matched to a specific file for review |
| `get_compliance` | Compliance stats for a specific principle |
| `report` | Log a decision, pattern, or review result (drift tracking) |
| `get_pr_review_data` | PR review prep (files, layers, diff commands, graph priorities) |
| `codebase_graph` | Build/update SQLite knowledge graph via pipeline, materialize `graph-data.json`, apply compliance overlay. Input: `{ detail_level?: "file" \| "entity", source_dirs?, root_dir?, changed_files? }`. Falls back to legacy scanner if SQLite unavailable. |
| `get_file_context` | File contents + imports + compliance data. Optional KG enrichment: `entities?: FileEntitySummary[]`, `blast_radius?: FileBlastRadiusEntry[]` (omitted when KG DB absent). |
| `reindex_file` | Incremental single-file reindex of the SQLite KG + rematerializes `graph-data.json`. Input: `{ file_path: string }`. Returns `{ status: 'updated' \| 'unchanged' \| 'deleted' \| 'rejected', entities_before, entities_after, changed }`. |
| `graph_query` | Query the KG for callers, callees, blast radius, dead code, FTS search, or ancestors. Requires prior `codebase_graph` run. Input: `{ query_type, target?, max_depth?, include_tests? }`. |
| `store_summaries` | Persist file summaries to `.canon/summaries.json` |
| `get_drift_report` | Full drift analysis (violations, trends, hotspots) |
| `get_decisions` | Grouped intentional deviation decisions |
| `get_patterns` | Observed codebase patterns (grouped, deduplicated) |
| `store_pr_review` | Store a PR review result for drift tracking |
| `get_dashboard_selection` | Current user focus from Canon Dashboard extension |

**Orchestration harness tools:**

| Tool | Purpose |
|------|---------|
| `load_flow` | Load and resolve a flow definition (fragments, spawn instructions, state graph) |
| `validate_flows` | Validate flow definitions (parse, fragment resolution, reachability) |
| `init_workspace` | Create or resume a workspace (`board.json`, `session.json`) |
| `update_board` | Mutate board state: enter/skip/block/unblock states, complete flow, set wave progress |
| `get_spawn_prompt` | Resolve spawn prompt for a state (variable substitution, overlays, wave context) |
| `report_result` | Record agent result, evaluate transitions, check stuck detection; returns `next_state` |
| `check_convergence` | Check iteration limits before re-entering a looping state |
| `list_overlays` | List available role overlays (expertise lenses injected into prompts) |
| `post_wave_bulletin` | Post inter-agent message during parallel wave execution |
| `get_wave_bulletin` | Read wave bulletin messages from other agents in the same wave |

## Canon Engineering Principles

This project uses Canon for engineering principles. Before writing or modifying code, load relevant principles via the `get_principles` MCP tool. Principles are in `.canon/principles/`. Severity levels: `rule` is non-negotiable, `strong-opinion` requires justification to skip, `convention` is noted but doesn't block.

## Hooks
<!-- last-updated: 2026-03-22 -->

`hooks/hooks.json` registers pre/post tool-use interceptors that run automatically. Key hooks: `destructive-guard.sh` (blocks dangerous git ops), `workspace-lock-guard.sh` (prevents concurrent builds), `pre-commit-check.sh` (secrets + compliance), `principle-inject.sh` (injects principle summaries into prompts), `agent-cost-tracker.sh` (tracks API costs). See `hooks/CLAUDE.md` for the full registry.

## Rate Limit Handling

All agent spawns may encounter API rate limits. When any agent spawn fails with a rate limit error (e.g. "Rate limit reached", HTTP 429, or "overloaded"):

- Retry up to 3 times with exponential backoff: wait 4 seconds before retry #1, 8 seconds before retry #2, and 16 seconds before retry #3.
- If spawning multiple agents in parallel and some succeed while others are rate-limited, keep the successful results and only retry the failed ones.
- If all retries for a given agent fail, inform the user and pause. Do NOT skip the phase — wait for the user to confirm retry or abort.

## Dashboard Context

When the Canon Dashboard extension is active, call `get_dashboard_selection` at the start of a conversation to pick up the user's current focus — selected graph node, active editor file, matched principles, and dependency context.
