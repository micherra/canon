---
id: prefer-deterministic-gate-over-prose-check
title: Prefer a Deterministic Gate Over a Prose Check for Mechanically-Verifiable Predicates
severity: convention
portable: true
scope:
  layers: []
  file_patterns:
    - "hooks/**"
    - "**/.github/**"
    - "**/ci/**"
tags:
  - process-health
  - gates
  - verify
  - ci
---

When a check currently relies on an LLM reading-and-judging, lives on a reviewer checklist or advisory step, or is a verified CI-vs-local gap — and its pass/fail decision can be expressed as a shell exit code — convert it to a deterministic gate wired into the verify pipeline.

## Rationale

An LLM or human performing a mechanical check by reading-and-judging is itself the unreliability source. LLMs may forget the check at higher autonomy tiers or rationalize past it under time pressure. Reviewers apply checklist items inconsistently. Advisory steps get skipped without surfacing the skip. A deterministic gate wired into the verify pipeline executes unconditionally for every run, every engineer, every tier — it cannot be silently omitted.

CI-vs-local gaps follow the same logic: if CI detects a class of defect that local verify does not, the gap itself is the bug. A gate that runs both locally and in CI eliminates the gap. A convention documenting the gap closes nothing.

Four instances of this pattern in Canon, across two independent build decisions (ADR-0013, 2026-06-11; PR #434, 2026-06-29), produced the same resolution every time: convert the prose check to a deterministic gate. No instance was better served by a stronger prose convention.

## Examples

**Bad — prose orchestrator check or reviewer checklist item for a mechanical predicate:**

```markdown
<!-- In CLAUDE.md verify step — fails open when orchestrator forgets it -->
- After the scribe runs, verify no stale lines were removed beyond the build scope.

<!-- Or as a reviewer checklist item — applied inconsistently under time pressure -->
- [ ] Confirm all newly-exported symbols have at least one non-doc-comment reference.
```

Both fail open: the orchestrator may omit the check; the reviewer may not apply it to every file; higher autonomy tiers skip HITL gates where advisory items live.

**Good — deterministic bash gate wired into the verify contract:**

```bash
#!/bin/bash
# hooks/dead-wire-gate.sh — exits 2 if any newly-exported symbol has zero real references
set -euo pipefail
BASE_COMMIT="${1:?Usage: dead-wire-gate.sh <base_commit>}"
# ... detection logic ...
echo "PASS dead-wire-gate: no unwired exports in new symbols"
```

```markdown
<!-- In CLAUDE.md verify step contract — runs unconditionally, every tier -->
`→ bash hooks/dead-wire-gate.sh {base_commit}` — standing dead-wire reachability postcondition.
```

The gate cannot be forgotten. It fails closed by construction (non-zero exit blocks the pipeline).

## Gate checklist

Adapt to local project conventions; for Canon the implementation home is `hooks/` (see ADR-0013):

1. The gate is a standalone executable (shell script, binary, or test runner command)
2. It accepts a diff base as its first argument; fails closed on a missing or invalid arg
3. It exits non-zero on any real violation; exits 0 on clean or out-of-scope
4. It has a fast automated test suite that runs locally (not only in CI)
5. It is added to the project's verify contract so it runs in every local verify pass
6. It prints a visible PASS line on success so the verify output is scannable

## Exceptions

A scoped prose convention is the right tool when:

- The check requires environment replication unavailable locally (version matrix, real daemon, external service) — forcing this into a gate produces expected-non-zero results that confuse a fail-closed pipeline
- The predicate cannot be expressed as a shell exit code at all (requires model judgment or human decision)
- The check is only meaningful for a specific file class, and running it outside that context would trigger false failures

In these cases, document the class in a scoped prose convention with explicit mandatory-run instructions — do not wrap an environment-conditional check in a gate.

## Related

[[architectural-fitness-functions]] — the same principle applied to architectural boundaries: automate what you want to enforce; documentation alone erodes under delivery pressure.

ADR-0013: `docs/adr/0013-deterministic-gates-as-bash-scripts.md` — WHERE Canon gates live (bash scripts in `hooks/`, wired into the verify contract). This convention documents WHEN to reach for a gate.

## Anti-Rationalization

| Excuse | Why It's Wrong | Correct Action |
|--------|---------------|----------------|
| "This principle is too strict for this case." | Principles prevent common failure modes specifically in edge cases and delivery pressure, where shortcuts look most attractive. | Apply the principle unless a concrete, bounded exception is documented under `## Exceptions`. |
| "We'll clean it up after this ships." | Deferred quality work usually becomes permanent debt and normalizes repeated violations. | Implement the compliant approach now, or record an explicit follow-up with owner and due date. |
| "Code review can catch this later." | Manual review is inconsistent under time pressure and cannot replace explicit constraints. | Encode compliance in code structure, tests, or linting so violations fail fast and repeatably. |
| "This is just a small change, so the rule doesn't matter." | Small changes accumulate into systemic drift when principles are waived incrementally. | Hold small changes to the same bar and verify the invariant still holds after each change. |
| "A convention is clearer for humans to read." | A convention with no gate is a suggestion with a known failure mode — it is skipped under pressure. | Write both: a gate that enforces and a convention that explains when to reach for one. |
| "The orchestrator will always check this." | LLMs fail open on omissions; advisory steps get skipped at higher autonomy tiers. | Wire the gate into the verify contract. The unconditional gate is the only mechanism that holds across all tiers. |

## Verification

- [ ] Updated files satisfy this principle's core constraint in behavior and structure.
- [ ] Any deviation is explicitly documented under `## Exceptions` with rationale and bounds.
- [ ] Tests, lints, or checks were added/updated where needed so regressions are detectable.
