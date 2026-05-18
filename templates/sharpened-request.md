---
template: sharpened-request
description: >-
  Lightweight PM-to-architect hand-off artifact. Produced by the PM's
  refine skill after sharpening a build request. Contains the problem,
  direction, scope boundaries, acceptance criteria, and exclusions.
used-by: [pm-orchestrator]
read-by: [architect, engineer]
output-path: ${WORKSPACE}/plans/${slug}/sharpened-request.md
---

# Template: Sharpened Request

Use this template when the PM produces a sharpened request after running
the refine skill. This is a hand-off artifact — it tells the architect
what to build, not how.

```
# Sharpened Request: {request-title}

## Problem
{One to three sentences: the real outcome the user wants, not the
solution they proposed. State the underlying need.}

## Direction
{One to two sentences: the agreed-upon approach direction. This is NOT
a technical design — it is the PM and user's consensus on WHAT to
build, not HOW.}

## Scope Boundaries
- **In scope**: {bullet list of what this build includes}
- **Out of scope**: {bullet list of what is explicitly excluded}

## Acceptance Criteria
| # | Criterion | Type |
|---|-----------|------|
| 1 | {observable condition} | mechanical / manual |

## Not Doing
{Explicit list of things that were discussed but deliberately excluded.
This section prevents scope drift — if something is not listed here
or in Scope Boundaries, it was never discussed and should not be
assumed in scope.}
- {thing 1 — why it is excluded}
- {thing 2 — why it is excluded}
```

## Rules

- The PM writes this after the refine conversation concludes.
- Trivial-tier requests skip this template entirely.
- The architect reads this as its primary requirements input.
- Keep it concise — 5 sections, not 8. The architect owns alternatives,
  value assessment, and requirement coverage in DESIGN.md.
- The "Not Doing" section is critical — it prevents scope drift during
  implementation.
