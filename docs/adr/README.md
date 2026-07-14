# Architecture Decision Records (ADRs)

## Purpose

This directory contains tracked, durable Architecture Decision Records — the "why we shipped X this way" that survives in git history. Unlike the ephemeral `.canon/decisions/` records (consumed in-build by engineers and discarded after the build completes), ADRs are permanent documents that explain consequential architectural choices to future contributors who were not present when the decision was made.

ADRs are **additive only** — once accepted, they are not deleted or overwritten. A superseding decision creates a new ADR that references the old one.

## Numbering Scheme

Files are named `NNNN-slug.md`, where `NNNN` is a 4-digit zero-padded sequential number (`0001`, `0002`, …).

**To assign the next number**: scan `docs/adr/` for the highest existing `NNNN` and add 1. Zero-pad to 4 digits.

**Concurrency note**: ADR numbers are assigned at design time by the scan-and-increment pattern above (`next = highest-on-disk + 1`). Because origin/main advances during the build window, two concurrent builds — or one build whose number is claimed by a PR that merges before it ships — will independently pick the same number. This is a recurring pattern, not a rare one: it has occurred across a dozen builds, and long multi-pass builds (especially security builds with several verify cycles) are the highest-risk because origin/main advances more often during the extended window. It surfaces as a benign additive-file conflict at PR merge (two new files with the same number prefix); resolve it by renaming the later ADR to the next available number and keeping both index rows in numeric order. No distributed counter is used.

**Mitigation — re-verify the number against origin/main immediately before ship, not only at design time.** A design-time scan is necessary but insufficient: it goes stale as origin/main lands new ADRs during the build. Immediately before the ship step, re-check the next-free number against both merged main and open PRs:

```
git fetch origin && git ls-tree origin/main docs/adr/ | grep -oE '[0-9]{4}' | sort | tail -1
```

If the chosen number is now taken, renumber the ADR (file rename + heading + frontmatter + README index row + any in-tree cross-references) before pushing. Resolving collisions by keeping both rows in numeric order is the canonical resolution; the pre-push mergeability check is the reliable detection point when a re-verify is skipped.

**Mechanical gate (automated backstop)**: `hooks/adr-number-check.sh` enforces the origin/main collision check automatically at push time — it blocks a `git push` that adds `docs/adr/NNNN-*.md` whose `NNNN` already exists on `origin/main` under a different slug (network-free, uses local `git ls-tree origin/main`). The manual re-verify above is still recommended pre-ship practice; the hook is a fail-closed backstop for missed or skipped re-verifies.

## The Conjunctive 3-Condition Gate

An ADR is written **only when ALL THREE conditions hold**:

1. **(a) Hard-to-reverse** — undoing the decision would require significant rework or breaking changes.
2. **(b) Surprising-without-context** — a future contributor reading the code or config would not naturally understand why this approach was chosen.
3. **(c) Genuine trade-off** — at least two options were considered and the chosen option has real costs, not just an obvious winner.

**All three, or no ADR.** Fail any one condition → no ADR. Do not write an ADR for routine choices, obvious decisions, or easily-reversed experiments.

### Scope

The gate applies **only to architect design-conversation decisions** — decisions recorded by the architect during the design phase of a Canon build. It does NOT apply to:

- Scribe updates (doc sync, CLAUDE.md edits)
- Engineer fix decisions (targeted bug fixes, lint corrections)
- Non-qualifying decisions that fail any of the three conditions above

Non-qualifying decisions may still get an ephemeral `.canon/decisions/` record if the architect judges that engineers need the context in-build, but they do not get a durable ADR.

## Lazy Creation

`docs/adr/` is populated only when a build produces a qualifying ADR. Builds with no qualifying decisions add nothing here. Do not create placeholder or stub ADR files.

## Template

Use `docs/adr/TEMPLATE.md` as the starting point for every new ADR. Copy it, fill in each section, and save as `docs/adr/NNNN-slug.md`.

## Index

| # | Title | Status | Date | Build |
|---|-------|--------|------|-------|
| [0001](0001-adr-template-placement.md) | ADR template lives at docs/adr/TEMPLATE.md and coexists with templates/design-decision.md | accepted | 2026-06-09 | close-the-adr-gap-the-architect-currently-writes-rich-design-decision |
| [0002](0002-loop-first-tick-baseline-semantics.md) | Loop first-tick is baseline-capture-only — transition rules never fire against an empty prior | accepted | 2026-06-11 | loop-framework-phase-c-self-paced-mode-schedulewakeup-adapter-session |
| [0003](0003-daemon-identity-proof-on-eaddrinuse-probe.md) | Daemon proves token possession via challenge-response on the EADDRINUSE probe, not a public version match | accepted | 2026-06-11 | harden-http-daemon-f1-same-user-token-read-f4-probe-identity-security |
| [0004](0004-retarget-boot-install-guards-onto-http-launch-path.md) | Retarget the boot-resolver + install-sim CI guards onto the HTTP launch path instead of deleting them | accepted | 2026-06-11 | adapt-install-sim-boot-resolver-ci-guards-for-the-http-mcpjson |
| [0005](0005-knowledge-graph-is-a-foundational-service.md) | knowledge-graph is a foundational service features may depend on | accepted | 2026-06-12 | enforce-ai-navigability-canon-already-preaches-name-the-grey-box-model |
| [0006](0006-relocate-cross-feature-shared-surfaces.md) | Relocate cross-feature shared surfaces to their correct architectural homes | accepted | 2026-06-12 | enforce-ai-navigability-canon-already-preaches-name-the-grey-box-model |
| [0007](0007-portable-flag-tier-signal.md) | portable: frontmatter flag is the tier signal; physical location is authoritative for shipping | accepted | 2026-06-11 | separate-canon-internal-conventions-from-the-universalshipped-principle |
| [0008](0008-dedup-collision-not-semantic.md) | Duplicate-concept prevention uses title/ID/scope collision detection, not semantic_search | accepted | 2026-06-11 | separate-canon-internal-conventions-from-the-universalshipped-principle |
| [0009](0009-orchestrator-action-declarative-signal.md) | orchestrator_action is a declarative signal the orchestrator consumes; the loop stays non-mutating | accepted | 2026-06-12 | add-a-first-class-orchestratoraction-directive-to-the-canon-loop |
| [0010](0010-decisions-ledger-on-event-log-not-cliff-ledger.md) | Orchestrator decisions ledger lives on the execution-store event log, not cliff-ledger or a new table | accepted | 2026-06-12 | batch-b-orchestrator-memory-hardening-1-orchestrator-self-handoff |
| [0011](0011-worktree-node-modules-symlink-containment.md) | Worktree node_modules via gitignored symlink with containment gate (not npm-install, not NODE_PATH) | accepted | 2026-06-11 | worktree-dev-environment-fixes-symlink-mcp-servernodemodules-into |
| [0012](0012-push-guard-fail-closed-cmdsub.md) | Push-guard uses fail-closed command-substitution span predicate instead of transparent-exec denylist | accepted | 2026-06-12 | address-pr-386-codex-p1-push-guard-bypass-resolve-merge-conflicts-with |
| [0013](0013-deterministic-gates-as-bash-scripts.md) | Deterministic verification gates are bash scripts invoked by the verify contract, not MCP tools | accepted | 2026-06-11 | deterministic-verification-hardening-batch-a-1-dead-wire-reachability |
| [0014](0014-writer-retire-guardrail-artifacts.md) | Writer retire action removes guardrail artifacts behind five safety gates | accepted | 2026-06-13 | address-two-codex-p2-review-comments-on-pr-396-artifact-retirement |
| [0015](0015-canonical-env-independent-mcp-auth-token-path.md) | Canon MCP auth token resolves to a single env-independent canonical path | accepted | 2026-06-12 | durable-fix-for-canon-mcp-clientdaemon-auth-token-path-nondeterminism |
| [0016](0016-finalize-no-destructive-teardown.md) | finalize_workspace performs no destructive teardown; teardown is post-merge only | accepted | 2026-06-13 | fix-finalizeworkspace-so-it-does-not-delete-the-canonslug-git-branch |
| [0017](0017-resilient-loop-dispatch-inline-tick-prompt.md) | Loop dispatch uses a self-contained inline tick prompt, not the /canon:loop-tick slash command | accepted | 2026-06-12 | make-the-canon-loop-framework-croncreateschedulewakeup-dispatch |
| [0018](0018-provenance-post-disclosure-spans.md) | Context provenance: spans computed post-disclosure, content_hash from pre-disclosure wording | accepted | 2026-06-23 | phase-1-step-0-trace-driven-evolution-provenance-instrumentation-emit-a |
| [0019](0019-link-graph-source-of-truth-for-orphans.md) | The link graph (inbound `[[wiki-link]]` edges) is the source of truth for principle orphan detection | accepted | 2026-06-21 | markdown-corpus-integrity-swap-gray-matteryaml-option-a-then-add-two |
| [0020](0020-principles-use-id-crosslinks.md) | Principles cross-link related principles by `[[id]]` in a ## Related prose section | accepted | 2026-06-23 | markdown-corpus-integrity-swap-gray-matteryaml-option-a-then-add-two (R3) |
| [0021](0021-frontmatter-schema-registry-lint-only.md) | Frontmatter is validated by a per-class schema registry, surfaced as a lint gate (parser stays lenient) | accepted | 2026-06-21 | markdown-corpus-integrity-swap-gray-matteryaml-option-a-then-add-two |
| [0022](0022-candidate-injection-temp-dir-not-worktree.md) | Candidate injection for the fitness gate uses a throwaway temp-dir copy, not a git worktree | accepted | 2026-06-24 | phase-1-deliverables-23-trace-driven-evolution-the-fitness-hard-gate-2 |
| [0023](0023-dead-wire-internal-use-compiler-api-resolution.md) | Same-file dead-wire internal-use detection uses TypeScript compiler-API binding resolution, not regex or syntactic allowlists | accepted | 2026-06-24 | rethink-the-dead-wire-gates-same-file-internal-use-detector-replace-the |
| [0024](0024-attribution-join-key.md) | Failure→artifact attribution joins on principle_id == in-context artifact_id | accepted | 2026-06-24 | build-the-attribution-consumer-attribute-step-for-trace-driven |
| [0025](0025-guardrail-corpus-injection-via-plugin-dir-sandbox.md) | Guardrail-corpus candidate injection via full-plugin sandbox + --plugin-dir override | accepted | 2026-06-25 | build-the-mutator-candidate-generation-for-trace-driven-evolution-phase |
| [0026](0026-untrusted-overlay-trust-boundary-enforcement.md) | Untrusted overlay trust boundary is compiler-and-test enforced, not per-sink fenced | accepted | 2026-06-27 | overlay-inert-data-hardening-4-redesign-replace-the-falsified-scanner |
| [0027](0027-overlay-content-structurally-inert-data.md) | Overlay content is structurally inert data (neutralize+fence+tier), not scanned-then-trusted instructions | accepted | 2026-06-25 | overlay-inert-data-hardening-4-redesign-replace-the-falsified-scanner |
| [0028](0028-workflows-library-home-and-lint-architecture.md) | workflows/ library home, node-AST lint via hooks/lint.sh, and scriptPath discovery for Inc 0 | accepted | 2026-06-29 | workflows-inc-0-canon-probe-canary-and-node-ast-workflows-ci-lint |
| [0030](0030-untrusted-project-dir-path-injection-allowlist.md) | Untrusted project-dir path-injection guard uses an allow-list, not containment | accepted | 2026-06-29 | address-all-11-open-github-code-scanning-alerts-3-actionsmissing |
| [0031](0031-agent-def-body-provenance-on-the-resolve-skills-seam.md) | Agent-definition-body provenance rides the resolve_agent_skills seam | accepted | 2026-07-01 | phase-2-agent-definition-body-provenance-seam-trace-driven-evolution |
| [0032](0032-review-violation-to-agent-def-code-author-join.md) | review_violation to agent-def attribution joins on the code-author agent-def, not a per-violation step key | accepted | 2026-07-01 | phase-2-agent-definition-body-provenance-seam-trace-driven-evolution |
| [0033](0033-success-pattern-learner-mines-auto-memory-digest-corpus.md) | Success-pattern learner mines the auto-memory digest corpus | accepted | 2026-07-01 | m1-success-pattern-learner (AgentKB R4) — design |
| [0034](0034-apply-provenance-timestamp-anchored-drift-table.md) | Apply-provenance is a timestamp-anchored drift.db table, not a commit-anchored record | accepted | 2026-07-02 | design-post-apply-live-regression-detection-rollback-for-trace-driven |
| [0035](0035-orchestrator-scoped-principles-are-a-distinct-measurement-surface.md) | Orchestrator-scoped principles are a distinct measurement surface, not code-review-citable | accepted | 2026-07-02 | fix-driftdb-test-fixture-leak-isolate-test-flow-writes-to-temp-db-purge |
| [0038](0038-stop-hook-tail-enforcement-gate.md) | Tail enforcement is a harness-fired Stop hook triggered by ship-completed | accepted | 2026-07-03 | add-a-deterministic-stop-hook-tail-enforcement-gate-delta-d3-from-the |
| [0039](0039-tail-enforcement-detection-uses-durable-journal-session-id.md) | Tail-enforcement detection uses a durable journal.session_id, not the ephemeral .lock | accepted | 2026-07-05 | add-a-deterministic-stop-hook-tail-enforcement-gate-delta-d3-from-the |
| [0040](0040-durable-decisions-corpus-via-reap-time-persistence.md) | Durable orchestrator-decisions corpus via reap-time persistence into a dedicated drift.db table | accepted | 2026-07-05 | explore-cross-workspace-decisions-ledger-readeraggregator-make-the |
| [0041](0041-cliff-transcript-source-via-subagent-filename-convention.md) | Cliffed-agent transcript source is resolved from the session-scoped Claude Code subagent filename convention | accepted | 2026-07-06 | forward-cliff-transcript-instrumentation-capture-a-transcript-snapshot |
| [0042](0042-corpus-drift-enforcement-gate-posture.md) | Corpus-drift enforcement gates are precision-first: fail-closed on a verified-clean scope, narrow high-signal idioms, inline suppression | accepted | 2026-07-06 | resolve-the-5-open-follow-ups-from-pr-462-corpus-optimization-5 |
| [0043](0043-fail-closed-write-receipt-completion-gate.md) | Fail-closed write-receipt completion gate (RCA Option C) | accepted | 2026-07-06 | design-spike-fail-closed-logstepcompleted-write-receipt-gate-so-an |
| [0044](0044-sensitive-path-deny-list-floor-beats-override.md) | Sensitive-path deny-list floors autonomy tier to supervised, beating override_tier | accepted | 2026-07-10 | add-a-sensitive-path-deny-list-floor-to-computeautonomytier-that-forces |
| [0045](0045-session-start-staleness-auto-refresh-mechanism.md) | Session-start staleness auto-refresh: ledger-emitted directive + ephemeral-workspace scribe→PR dispatch | accepted | 2026-07-10 | extend-session-watch-loop-to-observe-doc-staleness-and-kg-age-at |
| [0046](0046-diverse-lens-review-jury-triggers-on-adr-0044-floor-and-inverts-consolidation.md) | Diverse-lens review jury triggers on the ADR-0044 floor and inverts consolidation semantics on the vertical axis | accepted | 2026-07-10 | h2-posthog-program-add-a-diverse-lens-review-jury-for-high-stakes |
| [0047](0047-decisions-adrs-as-separate-kg-context-tables.md) | Decisions and ADRs modeled as a separate KG context table-pair with a record_kind subtype, content-hash-gated | accepted | 2026-07-10 | unified-agent-memory-m2-decisionsadrs-as-a-traversable-context-graph-kg |
| [0048](0048-tool-surfacing-gate-classification-model.md) | Tool-surfacing gate classifies agent-facing vs orchestrator-only via a central allowlist | accepted | 2026-07-10 | wire-inc-0-cross-session-chatter-into-agent-layer-fail-closed-tool-surfacing-gate |
| [0049](0049-retire-dead-cache-prefix-subsystem.md) | Retire the dead cache_prefix subsystem | accepted | 2026-07-11 | per-agent-cache-efficiency-rollup-retire-dead-cache-prefix-subsystem |
| [0050](0050-learning-reconcile-on-read-mcp-tool.md) | Learning-resolution reconcile is an MCP tool invoked reconcile-on-read, not a hook | accepted | 2026-07-11 | improve-canons-learning-resolution-flow-so-proposals-dont-orphan-in |
| [0053](0053-adr-number-check-open-pr-scan-fail-open.md) | adr-number-check's concurrent-open-PR scan WARNs (exit 0) and fails OPEN on gh unavailability — it never blocks a push on GitHub availability | accepted | 2026-07-11 | extend-hooksadr-number-checksh-to-detect-adr-number-collisions-against |
| [0054](0054-scope-recovery-by-rehandshake-not-persistence.md) | Recover session scope by re-handshake (spec-404), not by persisting the scope registry | accepted | 2026-07-11 | harden-resolvescope-against-daemon-restart-scope-loss-when-a-sessions |
