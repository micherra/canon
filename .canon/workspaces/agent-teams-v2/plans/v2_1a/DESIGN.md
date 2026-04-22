---
done_criteria:
  - id: "dc-01"
    description: "Canonical step vocabulary lives at references/runbook-vocabulary.md with 15 step IDs (13 functional + 2 mandatory tail) and versioned-change discipline documented."
    testable: "File exists. Exactly 15 step rows. Each step has id, default agent, dispatch, default HITL, purpose. Mandatory tail (context-sync, learn) present."
  - id: "dc-02"
    description: "planner-brief.md skill defines the strategic-analysis contract the planner follows to produce plans/${slug}/planning-brief.md."
    testable: "references/planner-brief.md exists. Defines required brief sections (problem statement, target users, acceptance criteria, alternatives, recommended approach, open questions). Registered in skills manifest."
  - id: "dc-03"
    description: "runbook-synthesis.md skill defines the MUST / MAY / MUST NOT synthesis contract including step schema, iterate-until-approved loop, and contract pairings."
    testable: "references/runbook-synthesis.md exists. MUST/MAY/MUST NOT sections present. References vocabulary strictly. Registered in skills manifest."
  - id: "dc-04"
    description: "planner agent body rewritten to load planner-brief + runbook-synthesis skills, emit planning-brief.md + runbook.md, and run the iterate-until-approved loop. maxTurns: 40, model: opus, permissionMode: plan, memory: project."
    testable: "agents/planner.md frontmatter matches spec. Body references both skills. Produces both artifacts when spawned against a test request."
  - id: "dc-05"
    description: "CLAUDE.md carries the L1 per-message intent re-classification amendment + pre-write gate guidance, gated by CANON_AGENT_TEAMS_MODE=on."
    testable: "CLAUDE.md contains explicit re-classification instruction + pre-write Canon-routing check. Text matches v2.1 §6.4 and §6.5 wording."
  - id: "dc-06"
    description: "canon-workspace-check.sh (L4) PreToolUse hook blocks Edit / Write / Bash-on-tracked-files when no active Canon workspace matches the current flow. Allowlist = .gitignore via git check-ignore oracle."
    testable: "Hook script exists, is executable, registered in hooks/canon-agent-teams/hooks.json. Unit tests cover: (a) edit of tracked file without workspace → blocked; (b) edit of gitignored file → allowed; (c) Bash with gitignored target → allowed; (d) Bash with tracked target → blocked."
  - id: "dc-07"
    description: "Intent-routing expansion: principle / learn / docs intents route through workspace-creating flows. Canon-writer, learner, and any docs intent have workspace-creating paths that predate L4 firing. Review HIGH-1 prerequisite."
    testable: "Running writer produces a workspace at .canon/workspaces/<slug>/. Running learner produces a workspace. Neither triggers L4 blocks. Integration test confirms."
  - id: "dc-08"
    description: "Pre-ship cold-start friction spike passes. 3 representative trivial requests (typo fix, rename, one-line config change) measured for iteration-0 latency. Review MEDIUM-6 satisfied."
    testable: "docs/v2.1a-coldstart-spike.md records measurements. Iteration-0 latency within target specified in spike design. If out of target, v2.1a is paused pending mitigation."
  - id: "dc-09"
    description: "Cross-artifact validation confirms end-to-end synthesis behavior against ≥ 5 distinct request types (bug fix, small feature, refactor, migration, test-gap equivalent). Same artifact quality as pre-synthesis static flows."
    testable: "docs/v2.1a-validation-report.md records per-request outcomes. Synthesis contract upheld in each run. No regressions observed against baseline artifacts."
---

## Design: v2.1a — Vocabulary + Synthesis (no substrate)

### North Star

**Vision:** `planner` synthesizes plan-specific runbooks per user request from a canonical step vocabulary, iterating with the user until approval. Static runbook files are replaced. No lifecycle persistence ships in v2.1a — that's v2.1b's concern.

**Done when:** dc-01 through dc-09 all pass. Architect review's HIGH-1 prerequisites (L4 allowlist + intent-routing expansion) are resolved before L4 ships.

**Constraints:**

- v2 Phase 1 exit criteria (Gate A in `docs/agent-teams-migration-plan-v2.md` §15.1) must be met first: `planner` and `engineer` exist and validate in ≥ 3 runs
- No lifecycle persistence (no new tables, no new MCP tools)
- No learner role expansion
- No commit trailer family additions
- No structured observation tags on artifacts
- No memory audit/groom/seed

### Approach

v2.1a decomposes into three layers that ship sequentially:

1. **Data layer** (Wave 1) — the canonical step vocabulary, a single file that downstream skills reference strictly.
2. **Skill layer** (Wave 2) — two skill files (`planner-brief.md`, `runbook-synthesis.md`) that encode the strategic and mechanical halves of the planner's responsibility.
3. **Integration layer** (Wave 3) — the planner agent body rewrite (loads both skills), CLAUDE.md L1 amendment, L4 hook, and the intent-routing expansion that makes L4's allowlist work for non-`build` Canon intents.
4. **Validation layer** (Waves 4–5) — cold-start friction spike (MEDIUM-6) then cross-artifact validation.

This ordering ensures each layer's dependencies exist before the next lands. The intent-routing expansion (dc-07) gates L4 shipping because without it, L4 blocks legitimate `principle` / `learn` / `docs` work.

### Canon principle alignment

- **agent-design-before-code** — this DESIGN document and INDEX are produced before any implementation work.
- **agent-plans-are-prompts** — each task plan is self-contained and directly executable.
- **agent-surface-assumptions** — the v2.1a design surfaces the HIGH-1 assumption (that L4 allowlist = `.gitignore` is correct) as an explicit dependency of dc-06 and dc-07.

### Key references

- Architectural source: `docs/agent-teams-migration-plan-v2.1.md` §§5, 6, 10.2
- Implementation plan: `docs/agent-teams-migration-plan-v2.md` §10.2
- Architect review: `docs/agent-teams-migration-plan-v2.1-review.md` (HIGH-1 blocks L4; MEDIUM-6 drives cold-start spike)

### Risks

See `docs/agent-teams-migration-plan-v2.md` §13. v2.1a-specific risks: planner inconsistency (MEDIUM), intent misclassification drift (MEDIUM; addressed via L1 + L4), vocabulary drift (LOW).
