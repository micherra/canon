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
2. **Write** each artifact using `Write` (for freeform files) or your designated MCP write tool (for structured artifacts with metadata sidecars such as `write_review`, `write_test_report`)
3. **Verify** the file exists by reading the first few lines after writing
4. **Then** report your terminal status (DONE, CLEAN, UPDATED, etc.)

If you cannot write an artifact (tool failure, permission error, path does not exist), report `BLOCKED` with detail: "Failed to write artifact: {path} — {reason}". Do NOT silently return without your declared artifacts.

## Relationship to Other Artifact Rules

- **`agent-template-required`** governs the FORMAT of your output — use the declared template and follow its structure exactly
- **`agent-missing-artifact`** governs missing INPUT artifacts from previous agents — what to do when an upstream agent failed to write
- **THIS rule** governs missing OUTPUT artifacts — your obligation to write before returning

Together these three rules form a complete artifact lifecycle: check input exists before starting (`agent-missing-artifact`), produce output in the correct format (`agent-template-required`), write output before returning (this rule).

## Rationale

Downstream agents depend on upstream artifacts. When the architect omits its research findings, downstream agents have no research context. When an engineer fails to write its summary, the tester cannot determine what to test. NF-14 showed that agents consistently skip artifact writes when not explicitly instructed, causing cascading pipeline failures.

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

- **Zero-artifact steps**: This rule does not apply to agents that genuinely produce no file artifacts for a given step. However, if your step was logged with `artifacts_expected`, you always have declared artifacts. If your step produces only a status verdict with no file (e.g., a reviewer reporting CLEAN in early-scan mode), verify with the orchestrator that no artifact path was declared before skipping.

## Context Budget

Artifact writes happen at the end of your execution. If you exhaust your context window before reaching the write step, the artifact is never produced. This is the most common cause of missing artifacts.

**Turn budget awareness**:
- At 50% of your available turns, verify you have started producing your primary artifact. If you have not started, reduce scope and begin writing immediately.
- At 75% of your available turns, your primary artifact MUST be written to disk. Remaining turns are for refinement only.
- If you detect you are running low on turns (repeated tool calls without progress, investigation spiraling), write a partial artifact immediately with a `## Status: Partial` heading and return BLOCKED. A partial artifact that exists is strictly better than a complete artifact that was never written.

**Early-write pattern**:
For complex artifacts (design documents, reviews, test reports), write a skeleton to disk early in your execution, then refine it in place:
1. After initial investigation, write a skeleton with headings and placeholder content
2. Fill in sections as you complete analysis
3. Final pass: polish and verify completeness

This ensures the artifact exists on disk even if you exhaust context mid-execution. The `enforceArtifacts` gate in `logStep` will catch a completely missing artifact, but it cannot catch an artifact you never started writing.
