# Changelog

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
