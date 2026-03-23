# Canon Templates

10 standardized output templates that ensure consistent, parseable artifacts across Canon's multi-agent pipeline. Enforced by the `agent-template-required` rule — every specialist agent must read the relevant template before producing output.

## How Templates Work

Each template is a markdown file with YAML frontmatter and placeholder sections agents fill in. Before an agent writes its output artifact, it reads the template file to understand the required structure. This contract between agents ensures downstream consumers can reliably locate and parse the sections they depend on.

For example, the tester agent reads the `### Coverage Notes` section of an implementor's `SUMMARY.md` to prioritize its work. If the implementor used a non-standard structure, the tester would have to guess. Templates eliminate that guessing.

The frontmatter in each template declares:
- `used-by` — which agent(s) produce this artifact
- `read-by` — which agent(s) consume it downstream
- `output-path` — where the artifact is written (with variable substitution)

## Template Table

| Template | Produced by | Consumed by | Output path | Purpose |
|----------|-------------|-------------|-------------|---------|
| `claudemd-template.md` | scribe | — | project root `CLAUDE.md` | Defines CLAUDE.md structure and required sections so the scribe produces a consistently organized project instructions file |
| `design-decision.md` | architect | implementor | `${WORKSPACE}/decisions/` | Records architecture decisions with options considered, tradeoffs, and rationale so implementors understand the reasoning behind non-obvious choices |
| `implementation-log.md` | implementor, fixer | tester, reviewer, scribe, shipper | `${WORKSPACE}/plans/${slug}/SUMMARY.md` | Task implementation summary including what changed, files modified, tests written, coverage notes, and Canon compliance declarations |
| `research-finding.md` | researcher | architect | orchestrator-provided path | Research findings per dimension, structured so the architect can synthesize multiple finding files into a coherent design |
| `review-checklist.md` | reviewer | shipper | `${WORKSPACE}/reviews/` | Code review output with principle violations flagged, risk notes, and a final APPROVE/BLOCK verdict the shipper uses to gate release |
| `security-assessment.md` | security | shipper | `${WORKSPACE}/plans/${slug}/SECURITY.md` | Vulnerability findings with severity ratings and remediation steps; shipper blocks on CRITICAL/HIGH findings |
| `session-context.md` | orchestrator | implementor | `${WORKSPACE}/context.md` | Session-level context including key decisions, patterns, and active blockers injected into implementor prompts at the start of each wave |
| `test-report.md` | tester | shipper | `${WORKSPACE}/plans/${slug}/TEST-REPORT.md` | Test coverage summary and results including issues found, gaps flagged, and overall verdict |
| `context-sync-report.md` | scribe | shipper | `${WORKSPACE}/plans/${slug}/CONTEXT-SYNC.md` | Cross-iteration documentation sync report confirming CLAUDE.md and context files reflect the completed work |
| `wave-briefing.md` | orchestrator | implementor | injected as `${wave_briefing}` | Wave execution briefing summarizing new shared code, established patterns, and gotchas from prior waves so later implementors avoid duplication and contradictions |

## Template Format

Templates use markdown with YAML frontmatter, a prose usage note, a fenced markdown block showing the exact artifact structure, and a rules section. Here is the `implementation-log.md` template as a representative example:

```
---
template: implementation-log
description: Structured format for implementor task summaries
used-by: [canon-implementor, canon-fixer]
read-by: [canon-tester, canon-reviewer, canon-scribe, canon-shipper]
output-path: ${WORKSPACE}/plans/${slug}/SUMMARY.md
---

# Template: Implementation Log

Use this template when producing the task summary after implementation.

```markdown
---
task-id: "{slug}-{NN}"
status: "{DONE|DONE_WITH_CONCERNS|BLOCKED|NEEDS_CONTEXT}"
agent: canon-implementor
timestamp: "{ISO-8601}"
commit: "{hash}"
---

## Implementation: {task-id}

### What Changed
{description}

### Files
| File | Action | Purpose |
...

### Tests Written
...

### Coverage Notes
#### Tested Paths
#### Known Gaps
#### Risk Mitigation Tests

### Canon Compliance
- **{principle-id}** ({severity}): {✓ COMPLIANT|⚠ JUSTIFIED_DEVIATION|✗ VIOLATION_FOUND → FIXED} — {detail}

### Verification
- [ ] New tests: {N} passing
- [ ] Full test suite: passing

### Concerns
### Blockers
` ` `

## Rules

- Write this summary immediately after committing
- Status must be one of the four defined values
- Canon compliance section is mandatory
```

The fenced inner block is what the agent writes to disk. Placeholder text in `{curly braces}` is replaced with actual content. HTML comments (`<!-- ... -->`) provide inline guidance that does not appear in the final artifact.

The `wave-briefing.md` template is structurally simpler — it has no inner fenced block because the orchestrator writes it directly, and it uses HTML comment markers to indicate where consultation fragment output is inserted.

## Conventions

- **Never modify template structure without updating all consuming agents.** Templates are the contract between agents. A section rename in `implementation-log.md` breaks the tester, reviewer, scribe, and shipper simultaneously.
- **Placeholder text uses `{curly braces}`.** Agents replace every placeholder; no placeholder survives into the final artifact.
- **Omit optional sections when empty.** Templates mark optional sections explicitly (e.g., `Concerns` and `Blockers` in the implementation log). Agents omit those sections entirely rather than leaving them blank.
- **Output paths use Canon variable syntax.** `${WORKSPACE}`, `${slug}`, and `${wave}` are resolved by the orchestrator or by the agent from its spawn context. Agents should not hardcode absolute paths.
- **The `agent-template-required` rule is non-negotiable.** An agent that skips template reading and produces a free-form artifact will fail downstream parsing. If a template does not exist for an artifact type, report `NEEDS_CONTEXT` rather than improvising.
