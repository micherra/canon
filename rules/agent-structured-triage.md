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

When a test fails or the build breaks, follow the five-step triage protocol before writing any fix. Do not retry blindly.

1. **Reproduce** — Run the failing command; capture exact error output
2. **Localize** — Narrow to the specific file/function/line causing the failure
3. **Reduce** — Find the minimal change that triggers the failure
4. **Fix** — Apply the smallest change that resolves the root cause
5. **Guard** — Add a test that would catch this regression

## Rationale

Blind retries compound confusion. Each failed attempt changes the state of the codebase, making the next attempt harder to reason about. Structured triage forces you to understand the failure before touching code — reproduce before localize, localize before fix. Without it, agents loop through the same wrong fixes and burn iterations without converging.

This rule operates *within* each iteration. `agent-convergence-discipline` governs how many iterations are allowed; this rule governs what happens inside each one.

## Exceptions

None. If you cannot reproduce the failure, report BLOCKED with the exact command you ran and the output you got.
