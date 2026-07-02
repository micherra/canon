---
id: no-literal-repo-state-counts
title: No Hand-Maintained Literal Repo-State Counts in Long-Lived Docs
severity: convention
portable: true
scope:
  layers: []
  file_patterns:
    - "**/*.md"
tags:
  - documentation
  - maintainability
  - lessons-learned
---

When embedding a count of living repo objects (files matching a glob, principles, hooks, stages, ADRs) in any `.md` file that persists across releases — protocol files, agent definitions, public README — do not embed a bare literal integer with no mechanical link to its source of truth. Use one of: (1) approximate/range ("~20 files", "more than two dozen ADRs"); (2) evidence-anchored ("64 built-in principles (`ls principles/**/*.md | wc -l`)") with the command inline; (3) generated (release badge or script-produced constant).

## Rationale

A bare count correct at authoring time drifts invisibly across releases — nothing re-checks it when a new file, principle, or hook is added in a later build. The decay is silent because the false claim looks identical to a true one; nothing fails, nothing errors, the count is just wrong.

The failure compounds when the same count is hand-copied into multiple sections of one document. A README audit found three internally contradictory principle counts (`59`, `85`, and `59` again in a third section) plus a wrong ADR count — none of the three matched the true value of `64`. Each had drifted independently across release cycles with no cross-reference constraint between them. Public-facing docs make this worse: an adopter reading two sections of the same README with two different counts loses trust in the whole document, not just the one number.

## Examples

**Bad — bare literal count with no link to source of truth:**

```markdown
Canon ships 59 built-in principles (6 rules, 35 strong-opinions, 18 conventions).
```

The next build that adds a convention makes this sentence wrong, and nothing catches it — no test reads this sentence, no gate re-derives the number.

**Good — evidence-anchored, with the command inline:**

```markdown
Canon ships 64 built-in principles (6 rules, 36 strong-opinions, 22 conventions —
`ls principles/**/*.md | wc -l`).
```

**Good — approximate/range form:**

```markdown
Canon ships more than two dozen conventions covering naming, testing, and process health.
```

## Exceptions

- Architectural constants that genuinely do not change (e.g., "6 dimensions" for a fixed craft rubric schema).
- Counts inside fenced example or hypothetical blocks that are explicitly illustrative.
- Explicitly-approximate counts ("~50 entries").
- Hardcoded counts in TypeScript/JavaScript source — a different enforcement class than long-lived prose.

## Anti-Rationalization

| Excuse | Why It's Wrong | Correct Action |
|--------|---------------|----------------|
| "The count is correct right now." | Correct-at-authoring-time is exactly the failure mode — nothing re-verifies it as the repo grows. | Use an approximate, evidence-anchored, or generated form so the sentence stays true without a follow-up edit. |
| "It's just one sentence, not worth the ceremony." | The README case shows one drifted sentence becomes three contradictory sentences once copied across sections. | Anchor the first instance correctly so copies inherit a stable form instead of a decaying literal. |
| "A reviewer will catch it when it's wrong." | The three-way README contradiction shipped and was only caught by a dedicated audit build, not routine review. | Prefer a form that cannot silently go wrong over relying on a human noticing a stale number. |

## Verification

- [ ] No new bare literal integer describing a living repo-state count (file/principle/hook/stage count) was added to a long-lived `.md` file without an approximate, evidence-anchored, or generated form.
- [ ] Any deviation is explicitly documented under `## Exceptions` with rationale and bounds.

## Related

See the reviewer advisory pointer (`literal-repo-state-count`) in `agents/reviewer.md` Stage 2.
