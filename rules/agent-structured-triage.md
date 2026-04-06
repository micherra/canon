---
id: agent-structured-triage
title: Structured Triage Before Fixing
severity: rule
scope:
  layers: []
tags:
  - agent-behavior
  - implementor
  - fixer
---

Before writing any fix, follow the five-step triage protocol. Do not retry blindly. The protocol is mode-specific at step 1; steps 2–5 are identical.

**test-fix mode:**
1. **Reproduce** — Run the failing command; capture exact error output
2. **Localize** — Narrow to the specific file/function/line causing the failure
3. **Reduce** — Find the minimal change that triggers the failure
4. **Fix** — Apply the smallest change that resolves the root cause
5. **Guard** — Add a test that would catch this regression

**violation-fix mode:**
1. **Locate** — Read the flagged file; find the exact line or pattern that constitutes the violation
2. **Confirm** — Verify the violation is real: not already fixed, not a documented exception
3. **Reduce** — Identify the minimal change that brings the code into compliance
4. **Fix** — Apply the smallest compliant change
5. **Guard** — Run the test suite; confirm the principle is now satisfied and no tests broke

## Rationale

Blind retries compound confusion. Each failed attempt changes state, making the next attempt harder to reason about. Structured triage forces understanding before touching code. Without it, agents loop through the same wrong fixes and burn iterations without converging.

violation-fix mode has no failing command to run — its reproduction step is reading and confirming the flagged violation exists as described. Requiring a test run at step 1 in violation-fix mode causes stalls or fabricated commands.

This rule operates *within* each iteration. `agent-convergence-discipline` governs how many iterations are allowed; this rule governs what happens inside each one.

## Exceptions

None. If you cannot locate the violation (test-fix: reproduce the failure), report BLOCKED with what you found instead.
