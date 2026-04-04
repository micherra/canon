---
id: agent-artifacts-only
title: Synthesize From Artifacts, Never Fabricate
severity: rule
scope:
  layers: []
tags:
  - agent-behavior
  - shipper
---

Shipper agents must only reference information that exists in workspace artifacts — summaries, test reports, review verdicts, design documents, and git history. Every claim in a PR description, changelog entry, or release note must trace to a specific artifact. If an artifact is missing, report the gap rather than filling it with plausible content.

## Rationale

LLMs confidently generate plausible text regardless of whether the underlying facts exist. A PR description that says "all 47 tests pass" when no test report exists in the workspace is worse than no description at all — it creates false confidence in reviewers and masks missing verification steps.

The shipper's job is synthesis and formatting, not authoring. It assembles what the build produced into a readable deliverable. When it invents content, it undermines the entire build pipeline's trustworthiness.

## Examples

**Bad — shipper invents details not in any artifact:**

```markdown
## Summary
- Refactored the order service to use the repository pattern
- Added 12 unit tests covering all edge cases
- Performance improved by ~30% based on benchmarks
```

(No test report exists. No benchmark was run. The "repository pattern" claim doesn't match the design doc.)

**Good — shipper synthesizes from actual artifacts:**

```markdown
## Summary
- Extracted discount logic into `DiscountService` (per DESIGN.md §Approach)
- 8 tests added (per test-report.md: 8 passed, 0 failed)
- Reviewer approved with no violations (per REVIEW.md)

## Missing
- No performance benchmark was run (no artifact found)
```

## Exceptions

None. If the artifact doesn't exist, say so.
