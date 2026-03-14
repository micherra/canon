---
id: agent-evidence-over-intuition
title: Suggestions Require Quantified Evidence
severity: rule
scope:
  languages: []
  layers: []
  file_patterns:
    - ".canon/LEARNING-REPORT.md"
    - ".canon/learning.jsonl"
tags:
  - agent-behavior
  - learner
---

Every suggestion in a learning report must cite quantified evidence — counts, rates, file lists, sample sizes. Never suggest a change based on impression, heuristic, or a single observation.

## Rationale

The learning loop's value depends entirely on trust. One noisy suggestion ("you should probably use Result types" based on seeing it in 2 files) erodes confidence in the entire report. Users stop reading reports that cry wolf. Every suggestion must pass the bar: "if the user asks 'why?', can I answer with numbers?"

A suggestion without evidence is an opinion. Canon already has opinions — they're called strong-opinions and they went through the principle authoring process. The learner doesn't get to invent new opinions based on vibes.

## Examples

**Bad — suggestion based on impression:**

```markdown
**Error handling** (confidence: medium)
Observed: The codebase seems to prefer Result types over exceptions
Suggest: Add to CONVENTIONS.md — "Use Result types for error handling"
```

**Good — suggestion backed by counts:**

```markdown
**Error handling** (confidence: high, 23/27 service files)
Observed: 23 of 27 files in src/services/ return `Result<T, E>` instead of throwing.
  Example: src/services/auth.ts returns `AuthResult` with ok/error discriminant.
  4 files still throw: src/services/legacy-payment.ts, src/services/email.ts,
  src/services/sms.ts, src/services/pdf.ts (all external integrations).
Suggest: Add to CONVENTIONS.md — "Return Result<T, E> from service functions; throw only in external integration wrappers"
```

**Bad — demotion based on gut feel:**

```markdown
**law-of-demeter** (current: convention)
This principle doesn't seem to match how the team writes code.
Suggest: Remove — not relevant to this project
```

**Good — demotion backed by compliance data:**

```markdown
**law-of-demeter** (current: convention → suggested: remove)
18% compliance across 14 reviews, 0 intentional deviations logged.
The principle has been evaluated 14 times and honored in only 3.
No team member has logged a deviation — the principle is being ignored, not overridden.
Suggest: Remove — consistently unenforced and not tracked as intentional
```

## Exceptions

None. If evidence is insufficient (below minimum thresholds), the correct action is to omit the suggestion, not to lower the evidence bar.
