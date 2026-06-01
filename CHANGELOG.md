# Changelog

## 2.4.0 (2026-06-01)

14 commits since v2.3.1. HTTP-transport groundwork, MCP-boot durability, area memory, observability, and hook reliability.

### Highlights

- **HTTP-transport groundwork** — per-connection scope registry and `resolveScope(extra)` foundation; 5 tool boundaries migrated to per-request resolution (#288, #290)
- **MCP-boot durability** — self-resolving `boot.sh` launcher with `PLUGIN_DATA` deps, PID reaper, and `--print-resolution` test flag; eliminates cold-start zero-tool failure (#287)
- **Area memory + hot-file caution** — engineers receive subsystem observations and hot-file warnings in context; persisted in `area_observations` DB table (#279)

### Features

- Per-connection scope registry: `resolveScope`, `registerConnectionScope`, `clearConnectionScope`, `resetForTesting`; `STDIO_SESSION_ID` sentinel for stdio transport (#288)
- Migrate 5 tool boundaries (`register-artifacts`, `register-init-workspace`, `register-knowledge`, `register-principles`, `register-agent-teams`) to per-request `resolveScope(extra)` (#290)
- Area memory enrichment + hot-file detection surfaced in engineer context via `resolve_agent_skills`; `area_observations` table, `AreaMemoryDao`, `detectHotFiles` (#279)
- Observability improvements: learner proposals YYY1–YYY4, catch-block sweep, `record_agent_metrics` audit events (#275)
- Doc-freshness drift dimension: `computeDocFreshness`, `DocFreshness` type, `DriftReport.doc_freshness`, freshness confidence adapter; scribe `docs/*.md` scope (#274)

### Fixes

- Durable MCP boot: self-resolving `boot.sh`, PID file lifecycle, reaper on SIGTERM/SIGINT; never uses `npx` (#287)
- Remediate ~67 hook silent-swallow sites; fix 2 flaky `ENOTEMPTY` tests (#280)
- Extend quality coverage to guardrail layer; close fail-open security regression (#278)
- Correct stale references to removed orchestration tooling; pre-existing flaky-test fix (#277)

### Documentation and Chores

- Add file line-count headroom check for architects (sug_IIII1) (#291)
- Remove spawn-timeout-watchdog hook (#276)
- Graft harness-primitives themes into supervised-build-quality (#273)
- Sync supervised-build-quality with merged PRs #262–#270 (#272)
- Bump version 2.3.0 → 2.3.1

## 2.3.0 (2026-05-28)

37 commits since v2.2.0. Quality hardening release: shell hygiene, holistic confidence scoring, hook reliability, and continuous learner expansion.

### Highlights

- **Shell hygiene** — `jq`-based JSON extraction replaces grep/sed across all hooks; shellcheck added as a real verify gate for shell scripts (#265, #271, #270, #268)
- **Holistic confidence scoring** — shared confidence engine (`ConfidenceAnnotation`, `ConfidenceTier`) wired to `write_review`, `get_compliance`, and `get_drift_report`; review and drift adapters compose multi-signal annotations (#259)
- **Hook reliability** — SIGPIPE elimination, quoted branch args, `canon-wave/` and `canon-task/` branch prefix support in destructive-guard; PostCompact narrative capture for Canon journals (#254, #266, #268, #261, #262)
- **Learner expansion** — RRR1–RRR4 shared hook test helpers, QQQ1 hook test coverage, WWW1 root-threading convention, WWW2 observable catch blocks (#257, #255, #269)
- **DAG dispatch enforcement** — dag-dispatch-guard advisory hook + `open_artifact` MCP tool for in-flow HTML inspection (#253)

### Features

- `wiki_lint` MCP tool — lint Canon's own meta-layer artifacts for contradictions, orphan principles, stale refs, and missing examples (#267)
- Shellcheck as real verify gate for hook shell scripts — `lint-test.sh` fail-closed, shellcheck directives added to all hooks (#265)
- Holistic confidence scoring across Canon — shared `confidence.ts` engine, per-violation annotations in `write_review`, confidence tiers in `get_drift_report` and `get_compliance` (#259)
- PostCompact narrative capture — Canon journals retain compact summary across `/compact` events (#261)
- DAG dispatch guard hook + `open_artifact` MCP tool (#253)
- 5 Canon improvements inspired by mattpocock/skills: CONTEXT.md glossary, autonomous competition mode, TDD primers, `/diagnose` command, rule-compliance dimension (#251)
- Tool-loop detection and spawn timeout watchdog in hooks (#245)
- Conditional GitHub release creation step for shipper agent (#242)
- Feed-forward pitfall enrichment with cross-session error+fix index (Epic 6) (#239)
- Learner findings RRR1–RRR4: shared hook test helpers and remaining hook tests (#257)
- Learner findings QQQ1 hook test coverage and QQQ2 verify ghost state (#255)
- Learner findings WWW1 root-threading convention + WWW2 observable catch blocks (#269)

### Fixes

- Replace grep/sed JSON extraction with `jq` + context-sync hook (#271)
- Use `jq` for JSON extraction, fix quoted branch args across hooks (#270)
- Add `canon-wave/` test case and fix stale comment in hook tests (#268)
- Allow `canon-task/` branch prefix in destructive-guard regex (#266)
- Resolve `projectDir` to git repo root in mcp-server (#264)
- PostCompact reads `compact_summary` from stdin (#262)
- Address PR #257 review comments on hook tests (#260)
- Remove 3 dead workspace directories (`research/`, `handoffs/`, `decisions/`) (#258)
- Remove invalid `isolation:"none"` from Agent spawn docs (#256)
- Eliminate SIGPIPE in session-start-context hook (#254)
- Resolve 3 open drift violations in orchestration layer (#252)
- MMM1 fix-mode SUMMARY obligation and MMM3 principle scope (#250)
- Extract shared hook helpers, fix worktree-resolution across 5 hooks (#248)
- Resolve `errors-are-values` and `fail-closed-by-default` violations in canon (#247)
- Detect and remove orphaned workspaces in janitor agent (#237)

### Documentation and Chores

- Bump all-dependencies group, 6 updates (#246)
- mcp-server CLAUDE.md 61-commit context sync (#249)
- Roadmap updates — Epic 6 shipped + 14 features from PR audits (#243)
- Learner proposals LL1/LL3/LL5 (#241) and KK1/KK5/KK6/KK9 (#240)
- Remove dead stubs, dependencies, and stale tests (#236, #238)
- Clean up obsolete roadmaps, add supervised-build-quality direction (#235)

## 2.2.0 (2026-05-21)

181 commits since v2.1.1. Major release: PM identity, dark factory foundations, interactive HTML artifacts, and continuous learning.

### Highlights

- **PM orchestrator identity** — Orchestrator reframed as Product/Project Manager. Planner absorbed into architect. Trivial builds skip architect and route directly to engineer. (#206, #210)
- **Dark factory Phase 1** — Confidence-gated auto-approval and auto-escalation protocol. Autonomy tier computation (autonomous/light-touch/supervised) based on build history and blast radius signals. (#232)
- **Interactive HTML artifacts** — Structured renderer templates for design briefs, review verdicts, codebase graphs, and file context. Force-directed graph with click-to-inspect panel and filtering. Canvas-based dependency graphs in file detail cards. (#202, #230, #226, #194, #190)
- **Continuous learning system** — Three-wave rollout: signal injection + correction capture, prediction tracking, prediction accuracy + reinforcement. (#174, #183, #188)
- **Agent optimizations** — Budget-aware checkpointing with maxTurns, tool-orientation protocols for reviewer and architect, progressive disclosure for large skill payloads. (#212, #229, #214)

### Features

- PM refine skill with stress-test protocol for requirements sharpening (#210)
- Two-layer principle model — init separation, writer fork, dogfood enforcement (#224)
- Scribe length-management pass — CLAUDE.md compressed 37% (#218)
- Reviewer team dispatch protocol with blast-radius-based fan-out (#147)
- DAG-based parallel execution via native agent teams API (#140)
- `get_context` composite MCP tool — batches principles, file context, drift, graph, and signals in one call
- `batch_log_steps` MCP tool for journal efficiency
- `capture_transcript` MCP tool for agent transcript archival
- `compute_autonomy_tier` MCP tool for risk-based gate behavior
- `get_next_escalation_strategy` MCP tool for automated failure recovery
- Pre-Analysis Gate (L1) closing the orchestrator dispatch enforcement triangle (#144)
- Verification-aware acceptance criteria pipeline (#171)
- Agent layout orientation and task-identity guard hardening (#193)
- Principle overrides for per-project customization (#172, #225)
- Mandate Claude Code native primitives at HITL touchpoints (#168)
- Build digest writer in `finalizeWorkspace` (#170)
- Agent-batch-tools rule wired to all 7 context agents (#164)
- Agent-effectiveness dimension and transcript access for learner (#165)
- Context-budget-dispatch agent rule (#159)
- Requirements interview phase for planner/architect agents
- Design conversation phase for architect with think-out-loud HAS_QUESTIONS
- Coverage maps at architect and engineer handoff points
- `write_test_report` manual verification structured field (#184)
- Wave-steward native skill for multi-wave migration (#133)
- Step-transition evaluator gate for structural quality checks (#176)
- Shipper default flipped from merge to PR creation (#149)

### Fixes

- Artifact write failures across all agents (#213)
- File-detail-card Canvas graph and blast-radius-tree snippet extraction (#208)
- Review template — narrative positioning, expandable file cards, hidden empty sections (#203, #205)
- `isAbsolute` workspace validation on remaining orchestration tools (#178)
- Session.json dead code removed — migrated to orchestration.db (#201)
- Violation timestamp deduplication and finalize side-effect ordering (#207)
- Slug truncation to prevent ENAMETOOLONG on verbose task names (#189)
- Principle scope, reviewer early output, skip-reason L4 enforcement (#195)
- Community detection and tag propagation for principle matching (#152)
- Integration gap prevention — architect DAG mandate, coverage map ownership (#175)
- Review-fix iteration loop with summary correction enforcement
- Worktree cleanup removed from shipper agent (#162)
- Mandatory tail reordered — context-sync before ship (#156)
- Round limits replaced with user-driven check-in pattern
- Pre-existing/flaky test failures tracked and fixed (#143)

### Refactors

- Legacy flow engine, wave infrastructure, prompt pipeline, and consultation dead code removed (#167, #180)
- Board consolidated into journal; `verify_completion` renamed to `finalize_workspace` (#160)
- Dead `post_message`/`get_messages` MCP tools removed (#186)
- Stale researcher agent retired and merged into planner (#145, #153)
- MCP Svelte app UIs deleted — renderer snippets kept (#221)

### Documentation

- README rewritten with Claude-centric enablement framing and HTML artifact showcase (#219)
- 30+ learner findings addressed across 8 batches (ZZ, PP, YY, EEE, BBB, GGG, III, JJ series)
- Principle overrides reference documentation (#225)
- CLAUDE.md context budget maintenance (#181)
- Soak period completed (20/20 runs) with all NF items resolved

### Dependencies

- Bumped all-dependencies group with 16 updates (#196)

## 2.1.1 (2026-04-23)

Patch release — planner maxTurns fix, cold-start latency mitigation, cross-artifact validation.

## 2.1.0 (2026-04-20)

Agent teams v2 — native agent teams API, DAG execution, reviewer team dispatch.

## 2.0.1 (2026-03-31)

Patch release — ADR-002 subprocess isolation, ToolResult contract, fail-closed gates.

## 1.4.2

Knowledge graph improvements and drift tracking enhancements.
