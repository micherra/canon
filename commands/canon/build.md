---
description: Full principle-driven development workflow from research to review
argument-hint: <task description> [--skip-research] [--skip-tests] [--skip-security] [--plan-only] [--review-only] [--wave N]
allowed-tools: [Read, Write, Edit, Bash, Glob, Grep, Agent]
---

Full Canon development workflow. Takes a task description and orchestrates research → architect → plan → implement → test → security → review. **The pipeline dynamically scales to the task** — small changes skip heavy phases, large features use the full pipeline.

You are a **thin orchestrator**. You spawn agents, pass context between them, and manage the workflow. You never do heavy work yourself. Stay under 30-40% context usage.

## Orchestrator Rules

- Read paths and metadata only. Never load file contents into your own context.
- Each agent spawn passes specific file paths to read, not raw content.
- Read summaries from agents, not full outputs.
- If an implementor reports BLOCKED, surface it to the user and wait for input.
- If an implementor reports DONE_WITH_CONCERNS, flag it in the final report.

## Parse Flags

From ${ARGUMENTS}, extract:
- **Task description**: Everything that's not a flag
- `--skip-research`: Skip research phase
- `--skip-tests`: Skip test phase
- `--skip-security`: Skip security scan
- `--plan-only`: Run research + architect + plan, stop before implementation
- `--review-only`: Skip everything, just run the reviewer on recent changes
- `--wave N`: Resume execution from wave N
- `--tier small|medium|large`: Override automatic tier classification

## Setup

Create the artifact directory:
```bash
TASK_SLUG=$(echo "${task_description}" | tr '[:upper:]' '[:lower:]' | tr ' ' '-' | sed 's/[^a-z0-9-]//g' | head -c 50)
mkdir -p .canon/plans/${TASK_SLUG}/research
```

## Task Classification

Before running the pipeline, classify the task into a tier. This determines which phases run. If the user passed `--tier`, use that. Otherwise, classify based on these signals:

| Signal | Small | Medium | Large |
|--------|-------|--------|-------|
| Files likely touched | 1-3 | 4-10 | 10+ |
| Architectural decisions | None — approach is obvious | 1-2 choices | Multiple approaches, tradeoffs |
| New modules/services | No | Maybe 1 | Yes, new boundaries |
| External APIs/integrations | No | Existing ones | New ones to research |
| Keywords in description | "fix", "add field", "rename", "update" | "add feature", "implement", "refactor" | "build system", "redesign", "migrate", "new service" |

### Tier → Pipeline mapping

| Phase | Small | Medium | Large |
|-------|-------|--------|-------|
| **1. Research** | Skip | Skip | ✓ (2-4 researchers) |
| **2. Architect** | Skip | ✓ | ✓ (Opus) |
| **3. Plan** | Skip (single implicit task) | ✓ | ✓ |
| **4. Implement** | ✓ (1 implementor, no waves) | ✓ (waves) | ✓ (waves + integration gates) |
| **5. Test** | Skip (implementor tests suffice) | ✓ | ✓ |
| **6. Security** | Skip | Skip | ✓ |
| **7. Review** | ✓ | ✓ | ✓ |
| **8. Log** | ✓ | ✓ | ✓ |
| **9. Summary** | Brief | Standard | Full |

**Small tasks** (1-3 files, obvious approach): Implement → Review → Log. One implementor, no architect, no planner. The orchestrator writes a minimal implicit plan directly: "Modify these files, apply these principles, run tests." This is the fast path for "add a field," "fix a bug," "rename a function."

**Medium tasks** (4-10 files, clear approach): Architect → Plan → Implement → Test → Review → Log. Skip research (the codebase and architecture are assumed known). Architect picks the approach, planner breaks it into waves, implementors execute.

**Large tasks** (10+ files, new systems, multiple approaches): Full pipeline. Research the problem space, architect with tradeoff analysis, plan waves, implement, test integration, security scan, review.

Announce the tier to the user: "Classified as **{tier}** — running {phases}. Override with `--tier large` if you want the full pipeline."

Any `--skip-*` flag applies on top of the tier. `--skip-tests` on a large task skips Phase 5 but keeps everything else.

## Pipeline

### Phase 1: RESEARCH (Large only, skippable with --skip-research)

Spawn 2-4 canon-researcher agents in parallel, each investigating one dimension:

1. **Codebase researcher**: "Research the existing codebase patterns relevant to: {task}. Save findings to .canon/plans/{slug}/research/codebase.md"
2. **Architecture researcher**: "Examine how this change fits the existing architecture: {task}. Save findings to .canon/plans/{slug}/research/architecture.md"
3. **Domain researcher** (if external APIs/libs involved): "Research external APIs and best practices for: {task}. Save findings to .canon/plans/{slug}/research/domain.md"
4. **Risk researcher** (for larger tasks): "Identify edge cases, failure modes, and security considerations for: {task}. Save findings to .canon/plans/{slug}/research/risk.md"

Each researcher gets: task description, their dimension, CLAUDE.md path, and the Canon principle index.

Wait for all researchers to complete. Read their summary outputs (not full findings).

### Phase 2: ARCHITECT & PLAN (Medium + Large)

Spawn canon-architect agent:
"Design the technical approach for: {task}. Read research findings from .canon/plans/{slug}/research/. Load relevant Canon principles. Save design to .canon/plans/{slug}/DESIGN.md. Then break the design into atomic task plans — save plans to .canon/plans/{slug}/{task-id}-PLAN.md and index to .canon/plans/{slug}/INDEX.md"

The architect gets: task description, research file paths, Canon principle directory paths, project conventions path.

If the architect's design has **open questions for user**, present them and wait for answers. Pass answers back to the architect if needed.

**If --plan-only**: After the architect finishes, present the design and plan index to the user and stop.

Read the INDEX.md to understand the wave structure.

### Phase 4: IMPLEMENT (all tiers — parallel within waves for Medium/Large, single task for Small)

For each wave (starting from --wave N if specified, else wave 1):

1. Read INDEX.md to get tasks in this wave
2. For each task in the wave, spawn a canon-implementor agent in parallel:
   "Execute the task plan at .canon/plans/{slug}/{task-id}-PLAN.md. Read project conventions at .canon/CONVENTIONS.md if it exists. Read task conventions at .canon/plans/{slug}/CONVENTIONS.md if it exists. Read CLAUDE.md. Commit atomically. Save summary to .canon/plans/{slug}/{task-id}-SUMMARY.md"
3. Wait for all implementors in the wave to complete
4. Read their summary statuses:
   - **DONE**: Proceed
   - **DONE_WITH_CONCERNS**: Note concerns, proceed
   - **BLOCKED**: Surface to user, wait for resolution
   - **NEEDS_CONTEXT**: Surface to user, wait for clarification
5. **Integration gate**: After all tasks in a wave complete, run the project's full test suite:
   ```bash
   # Detect and run the project's test command
   # npm test / yarn test / pytest / go test ./... / etc.
   ```
   - If tests pass: proceed to next wave
   - If tests fail: surface failures to the user as a blocker. Do NOT start the next wave until failures are resolved. The failing tests may indicate cross-task integration issues within this wave.
6. If integration gate passes, proceed to next wave

### Phase 5: TEST (Medium + Large, skippable with --skip-tests)

Spawn canon-tester agent:
"Write integration tests and fill coverage gaps. Implementors already wrote unit tests — focus on cross-task integration and missed coverage. Read task summaries from .canon/plans/{slug}/*-SUMMARY.md. Read implementor test files. Save test report to .canon/plans/{slug}/TEST-REPORT.md"

If tester reports IMPLEMENTATION_ISSUE, surface to user.

### Phase 6: SECURITY (Large only, skippable with --skip-security)

Spawn canon-security agent:
"Scan implemented code for security vulnerabilities. Read task summaries from .canon/plans/{slug}/*-SUMMARY.md for file list. Save assessment to .canon/plans/{slug}/SECURITY.md"

If any **critical** findings, surface to user as a blocker.

### Phase 7: REVIEW (all tiers)

Spawn canon-reviewer agent:
"Review all code changes from this build. Use git diff to see changes. Save review to .canon/plans/{slug}/REVIEW.md"

Read the review verdict from REVIEW.md:
- **BLOCKING**: Rule-severity violations found. Surface all violations to the user. The build is NOT complete — violations must be fixed (spawn canon-refactorer for each violation, or surface for manual fix). After fixes, re-run the review.
- **WARNING**: Strong-opinion violations found. Surface to the user with fix suggestions. The build can proceed, but note the violations in the final summary.
- **CLEAN**: No violations. Proceed.

### Phase 8: LOG (all tiers)

Log the review results for drift tracking using the `report` MCP tool (type=review). Extract from `.canon/plans/{slug}/REVIEW.md`:
- `files`: The list of files that were reviewed
- `violations`: Each violation's `principle_id` and `severity`
- `honored`: IDs of principles that were honored
- `score`: The pass/total counts for rules, opinions, and conventions
- `verdict`: The verdict from the review header (`BLOCKING`, `WARNING`, or `CLEAN`)

### Phase 9: SUMMARY (all tiers)

Present a final summary to the user:
- What was built
- How many tasks/waves completed
- Which Canon principles were applied
- Any concerns or issues flagged
- Security findings (if any)
- Review results
- Links to all artifacts in `.canon/plans/{slug}/`

At the end of the summary, include: "Tip: Run `/canon:learn` periodically to discover codebase patterns and refine principles based on review data."
