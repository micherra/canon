# Changelog

## [2.8.0](https://github.com/micherra/canon/compare/v2.7.0...v2.8.0) (2026-06-07)


### Features

* **http-epic-phase2:** Streamable-HTTP MCP daemon — per-session transport, loopback auth, scope handshake, supervisor (flag-dark) ([#342](https://github.com/micherra/canon/issues/342)) ([a2a1c67](https://github.com/micherra/canon/commit/a2a1c67adeb6c3e86b9e587b2e13c616d8598e49))
* **learner:** promote batch 5 — worktree_path, renderer conventions, stream-idle resume, counterexample obligation ([#341](https://github.com/micherra/canon/issues/341)) ([404517b](https://github.com/micherra/canon/commit/404517ba54b9b43fc044947988a2c03c41af36cb))
* **learner:** promote sug_NNNNNN1 + watch_WWWWW2 + watch_VVVVV3 (3-item batch) ([#334](https://github.com/micherra/canon/issues/334)) ([9c3aaec](https://github.com/micherra/canon/commit/9c3aaec7dd7be66d6222c37e03da80df0b053752))
* **learner:** promote watch_KKKKK1 — reviewer Stage 6 scope-parity check for precision/scope fixes ([#332](https://github.com/micherra/canon/issues/332)) ([c0efa0d](https://github.com/micherra/canon/commit/c0efa0d73d80ef014eea00d1bf2d3de5b6285f57))
* **learner:** promote watch_VVVVV2 — severity-vocabulary consistency obligations (writer pre-commit + reviewer Stage 2) ([#335](https://github.com/micherra/canon/issues/335)) ([b1ceea5](https://github.com/micherra/canon/commit/b1ceea5003249f2f0bc93c91bdbad57aaab043bb))


### Bug Fixes

* **file-card:** repair broken file-detail-card rendering in review.html ([#338](https://github.com/micherra/canon/issues/338)) ([d31614c](https://github.com/micherra/canon/commit/d31614c8b0a2c0c0c3614c907b7044c84a162fb4))
* **hooks:** fix destructive-guard false positives on comments/quoted strings ([#337](https://github.com/micherra/canon/issues/337)) ([886fd67](https://github.com/micherra/canon/commit/886fd67fc8714082dec20e5082d4ce70e2ab5f03))
* **renderer:** render GFM tables in review narrative panel ([#336](https://github.com/micherra/canon/issues/336)) ([7330b17](https://github.com/micherra/canon/commit/7330b17eedb04991f44bb60c0b9f787ad31d3980))

## [2.7.0](https://github.com/micherra/canon/compare/v2.6.0...v2.7.0) (2026-06-06)


### Features

* **diagnostics:** wiki-lint scope_layers check + retroactive invalid-layer fixes (sug_VVVVV1) ([#321](https://github.com/micherra/canon/issues/321)) ([891e1af](https://github.com/micherra/canon/commit/891e1af51ad669a4d65a47df4702388d5934d4f9))
* **janitor:** detect and remove empty workspace husk directories ([#325](https://github.com/micherra/canon/issues/325)) ([cbec8f6](https://github.com/micherra/canon/commit/cbec8f63281d8905d911584c5a0866744a4c0b09))
* **learner:** promote sug_DDDDD1 — doc-trim-fact-preservation convention + post-scribe scope guard ([#330](https://github.com/micherra/canon/issues/330)) ([ee32149](https://github.com/micherra/canon/commit/ee321493a1f971179fec22685a6b1e4a26740ba2))
* **learner:** promote sug_VVVV1 — agent→tool reachability gate (reviewer Stage 2 + wiring enrichment) ([#328](https://github.com/micherra/canon/issues/328)) ([1f53b59](https://github.com/micherra/canon/commit/1f53b5922207665497e34778a555c0487d38b78c))
* **orchestration:** wire build diff stats into FlowRunEntry at finalize (craft Piece B) ([#327](https://github.com/micherra/canon/issues/327)) ([f0c56fe](https://github.com/micherra/canon/commit/f0c56fed2bc6d3ac9957e4444c5ba7ef2b6b2020))
* **writer:** require executing verification commands against the real tree before commit (sug_EEEEE1) ([#324](https://github.com/micherra/canon/issues/324)) ([fef7988](https://github.com/micherra/canon/commit/fef7988f5bde29f945c05bf017e292d3122a1195))

## [2.6.0](https://github.com/micherra/canon/compare/v2.5.0...v2.6.0) (2026-06-05)


### Features

* **http-epic-phase2:** isolation-finish slice — per-project JobManager + http-server scope ([#316](https://github.com/micherra/canon/issues/316)) ([eec09ca](https://github.com/micherra/canon/commit/eec09ca50d37f4975415b4680973377c9d8d831a))
* **kg-sync:** lazy commit-granularity KG freshness + self-healing orphan prune ([#303](https://github.com/micherra/canon/issues/303)) ([057aacc](https://github.com/micherra/canon/commit/057aaccbc2a245040971012391b4e77aa7171912))
* **learner:** outcome-weighted JUDGE + staleness CONSOLIDATE ([#306](https://github.com/micherra/canon/issues/306)) ([e9f9aee](https://github.com/micherra/canon/commit/e9f9aeebf4ffea3ea1e6e3d680a2644e493de8f4))
* **principle:** promote line-limit-split-into-siblings convention (sug_UUUU2, 4/4) ([#314](https://github.com/micherra/canon/issues/314)) ([34a3a5d](https://github.com/micherra/canon/commit/34a3a5ddc396ca96cbb9e8a42251843c964bcf6a))
* **scribe:** constrain context-sync to build-changed sections; remove size-budget trimming ([#312](https://github.com/micherra/canon/issues/312)) ([7ac170c](https://github.com/micherra/canon/commit/7ac170c3591b659f1a987c91b113e9da7a7bc0ce))
* **writer:** route principle writes by tier — tracked-source vs installed-copy ([#318](https://github.com/micherra/canon/issues/318)) ([dcfba2c](https://github.com/micherra/canon/commit/dcfba2cb9844a6ba528894eb3e385859ea9c17ca))


### Bug Fixes

* **hooks:** subcommand-aware tokenizer for destructive-guard (Phase 0) ([#300](https://github.com/micherra/canon/issues/300)) ([4ebd6ed](https://github.com/micherra/canon/commit/4ebd6ed80e1b98f6e3bb40494ffb0fa55daa0362))
* **kg-embedding:** skip real-embeddings suite when model CDN unreachable (CI 429) ([#319](https://github.com/micherra/canon/issues/319)) ([8e45020](https://github.com/micherra/canon/commit/8e45020ea937b27eb8c3b55d32ed8e7d710fb103))
* **protocol:** DAG single-task guard + BUILD_BASE_COMMIT worktree base ([#285](https://github.com/micherra/canon/issues/285)) ([16eb4d9](https://github.com/micherra/canon/commit/16eb4d9f8524749b667eda4a2b9a184a070ffb01))
* **server-state:** replace fixed-dirname-count pluginDir seed with marker-walk ([#315](https://github.com/micherra/canon/issues/315)) ([e8ddf27](https://github.com/micherra/canon/commit/e8ddf27bcaa38f805cab13a3d99e9a5da9da1369))

## [2.5.0](https://github.com/micherra/canon/compare/v2.4.1...v2.5.0) (2026-06-04)


### Features

* **craft-v2:** redefine craft as a principle-backed 6-dimension profile (per-review + periodic audit + learner drift) ([#301](https://github.com/micherra/canon/issues/301)) ([60ed698](https://github.com/micherra/canon/commit/60ed6984dc1d1c5b273cbd33af9e60dcac43329d))
* **handoff:** graceful agent handoff phase 1 — reconcile_workspace + harvest substrate ([#281](https://github.com/micherra/canon/issues/281)) ([13d0c76](https://github.com/micherra/canon/commit/13d0c76b25c06a58775c468c12a5b96e748f6281))
* **http-epic-phase1:** finish Phase 1 — remove projectDir global (1c+1d) ([#304](https://github.com/micherra/canon/issues/304)) ([8e1d55d](https://github.com/micherra/canon/commit/8e1d55ddedf7a84b4363d27b81a4cab45eeeb3e0))
* **learner:** address BBBB1-BBBB4 — enrichment pipeline convention + docs ([#282](https://github.com/micherra/canon/issues/282)) ([d166795](https://github.com/micherra/canon/commit/d166795fe2d3e490b4e41921038e73553039c7aa))
* **review:** 6 quality-playbook-inspired improvements to reviewer, tester, and orchestrator ([#283](https://github.com/micherra/canon/issues/283)) ([15f1ef2](https://github.com/micherra/canon/commit/15f1ef2a05e1700d7af2302ffd921e1229b712d9))
* wire reconcile_workspace into resume + post-subagent path (observe+surface only) ([#309](https://github.com/micherra/canon/issues/309)) ([e31fd98](https://github.com/micherra/canon/commit/e31fd981002916dea3709da4c8da530ded39e642))


### Bug Fixes

* **review-graph:** unify force-directed engine — fixes clustered/unreadable dependency map ([#307](https://github.com/micherra/canon/issues/307)) ([ca5b68f](https://github.com/micherra/canon/commit/ca5b68f69cf6d77fb78a3c4a083a03aa1975146f))

## [2.4.1](https://github.com/micherra/canon/compare/v2.4.0...v2.4.1) (2026-06-03)


### Bug Fixes

* **artifact-validation:** harden SUMMARY path validation + authoritative artifact-location spec ([#298](https://github.com/micherra/canon/issues/298)) ([e4b1cea](https://github.com/micherra/canon/commit/e4b1ceaecc637652f13bef4cf122f4a3e3db319d))
* **mcp-boot:** ESM dep reachability + bounded deps-ready wait for clean installs ([#296](https://github.com/micherra/canon/issues/296)) ([bd452f9](https://github.com/micherra/canon/commit/bd452f9e3d65537cb78b2f55f5b5ab7aa4a2817d))

## [2.4.0](https://github.com/micherra/canon/compare/v2.3.0...v2.4.0) (2026-06-02)


### Features

* **diagnostics:** doc-freshness drift dimension + scribe docs/*.md scope (watch_ZZZ1) ([#274](https://github.com/micherra/canon/issues/274)) ([9432ce9](https://github.com/micherra/canon/commit/9432ce97f26800e862d0fc671f28a04e78dc80c2))
* **http-epic-1a:** per-connection scope registry + resolveScope ([#288](https://github.com/micherra/canon/issues/288)) ([a52a4e9](https://github.com/micherra/canon/commit/a52a4e967d5622a5b935998123def1fa29c43b1a))
* **http-epic-1b:** migrate 5 tool boundaries to per-request resolveScope(extra) ([#290](https://github.com/micherra/canon/issues/290)) ([62e4cce](https://github.com/micherra/canon/commit/62e4cce2bb7fec3f5cee58ecfd2cacf6066e5419))
* **memory:** area memory + hot-file caution for engineers ([#279](https://github.com/micherra/canon/issues/279)) ([222c0fe](https://github.com/micherra/canon/commit/222c0fefee55ae5f451e355b54866fbf95b57d1f))
* **observability:** address learner proposals YYY1-YYY4 + catch-block sweep ([#275](https://github.com/micherra/canon/issues/275)) ([a7cbe3b](https://github.com/micherra/canon/commit/a7cbe3bf4c66f048a4ea1d8b5192e1e8f82f8e6a))
* **release:** adopt release-please for automated Canon releases ([#293](https://github.com/micherra/canon/issues/293)) ([8d1f1ed](https://github.com/micherra/canon/commit/8d1f1edb33d6b7cba7d23c0b66564b4f5151ea7c))


### Bug Fixes

* extend Canon quality coverage to guardrail layer + close fail-open security regression ([#278](https://github.com/micherra/canon/issues/278)) ([25d1cc8](https://github.com/micherra/canon/commit/25d1cc860ae86adbf0df36a39caacdabe22349e8))
* **hooks:** remediate ~67 silent-swallow sites + fix 2 flaky tests ([#280](https://github.com/micherra/canon/issues/280)) ([a6a653c](https://github.com/micherra/canon/commit/a6a653c3441105bd7d77958cee8a777e584a2e18))
* **mcp-boot:** durable boot via self-resolving launcher + PLUGIN_DATA deps + PID reaper ([#287](https://github.com/micherra/canon/issues/287)) ([16585e6](https://github.com/micherra/canon/commit/16585e6478d2418df67a07ce1e14f9121e08a0a2))

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
