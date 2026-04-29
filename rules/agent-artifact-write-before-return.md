---
id: agent-artifact-write-before-return
title: Write All Declared Artifacts Before Returning
severity: rule
tags: [agent-behavior, artifacts, workspace]
---

When your spawn prompt declares expected artifacts (via `artifacts_expected` in the orchestrator's `log_step` call, or via explicit "save to {path}" instructions), you MUST write each artifact to its declared path before reporting your terminal status.

## Rule

Follow this sequence for every declared artifact:

1. **Identify** all artifact paths from your spawn prompt. Look for:
   - Explicit paths like "save to `${WORKSPACE}/plans/${slug}/DESIGN.md`"
   - Structured artifact declarations from the orchestrator's `artifacts_expected` list
2. **Write** each artifact using `Write` (for freeform files) or your designated MCP write tool (for structured artifacts with metadata sidecars such as `write_research_synthesis`, `write_review`, `write_test_report`)
3. **Verify** the file exists by reading the first few lines after writing
4. **Then** report your terminal status (DONE, CLEAN, UPDATED, etc.)

If you cannot write an artifact (tool failure, permission error, path does not exist), report `BLOCKED` with detail: "Failed to write artifact: {path} — {reason}". Do NOT silently return without your declared artifacts.

## Relationship to Other Artifact Rules

- **`agent-template-required`** governs the FORMAT of your output — use the declared template and follow its structure exactly
- **`agent-missing-artifact`** governs missing INPUT artifacts from previous agents — what to do when an upstream agent failed to write
- **THIS rule** governs missing OUTPUT artifacts — your obligation to write before returning

Together these three rules form a complete artifact lifecycle: check input exists before starting (`agent-missing-artifact`), produce output in the correct format (`agent-template-required`), write output before returning (this rule).

## Rationale

Downstream agents depend on upstream artifacts. When the planner omits its research notes, the architect has no research context. When an engineer fails to write its summary, the tester cannot determine what to test. NF-14 showed that agents consistently skip artifact writes when not explicitly instructed, causing cascading pipeline failures.

The `logStep` tool now scans for missing artifacts on completion and returns an `artifacts_missing` field — the orchestrator can detect failures earlier, but prevention is better than detection.

## Examples

**Bad — agent returns DONE without writing declared artifacts:**

```
Orchestrator: "Save your findings to ${WORKSPACE}/research/codebase.md"

Agent:
[reads code files]
[produces findings in internal context]
Status: DONE
```

The findings never reach disk. The architect loads an empty or nonexistent file. Pipeline stalls.

**Good — agent writes artifact, verifies existence, then returns DONE:**

```
Orchestrator: "Save your findings to ${WORKSPACE}/research/codebase.md"

Agent:
[reads code files]
[produces findings]
[Write tool: ${WORKSPACE}/research/codebase.md]
[Read tool: ${WORKSPACE}/research/codebase.md — first 3 lines confirm content written]
Status: DONE
```

## Exceptions

- **Planner agent**: The planner operates in `plan` permissionMode whose artifacts are captured inline by the orchestrator (the orchestrator writes them). The planner's output text IS its artifact — no `Write` call needed.
- **Zero-artifact steps**: This rule does not apply to agents that genuinely produce no file artifacts for a given step. However, if your step was logged with `artifacts_expected`, you always have declared artifacts. If your step produces only a status verdict with no file (e.g., a reviewer reporting CLEAN in early-scan mode), verify with the orchestrator that no artifact path was declared before skipping.
