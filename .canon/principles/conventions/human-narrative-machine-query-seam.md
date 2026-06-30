---
id: human-narrative-machine-query-seam
title: Human-Narrative HITL Artifacts Stay Prose; Machine-Queried State Is Typed
severity: convention
portable: false
scope:
  layers: []
  file_patterns:
    - "agents/**"
    - "rules/**"
    - "references/**"
    - "CLAUDE.md"
    - "mcp-server/src/features/orchestration/**"
tags:
  - artifacts
  - hitl
  - orchestration
  - architecture
---

Canon's canonical review output is a file-pair: `reviews/REVIEW.md` (human-narrative prose, rendered to `review.html` and read by a human at the review-verdict HITL gate) and `reviews/REVIEW.meta.json` (machine-consumed structured sidecar with typed `violations[]`, `score`, `verdict`, and `honored[]` rows). **The prose artifact and the structured sidecar must remain two separate files.** Human-narrative HITL artifacts — `DESIGN.md`, the `REVIEW.md` prose body, `PLAN.md` — MUST stay prose permanently. Only machine-consumed state (review findings rows, coverage, touched-files, budget-debit events) may be typed or queryable.

## The Seam

The seam already exists physically in the codebase. The `write_review` MCP tool (registered via `mcp-server/src/features/orchestration/tools/write-review.ts`) always writes both artifacts atomically:

- `reviews/REVIEW.md` — the human-narrative prose body. Rendered to `${WORKSPACE}/artifacts/review.html` by the renderer agent before the review-verdict HITL gate. The human reads this at the gate; the orchestrator presents it via `open_artifact`.
- `reviews/REVIEW.meta.json` — the machine-consumed structured sidecar. Contains typed `violations[]`, `score: { rules, opinions, conventions }`, `verdict`, `honored[]`, and `files[]`. The orchestrator and consolidator query this programmatically.

When a `step_id` is provided to `write_review`, it also writes a step-scoped pair (`REVIEW-{step_id}.md` + `REVIEW-{step_id}.meta.json`) to prevent concurrent reviewer overwrite races — the canonical pair is always refreshed (see `write-review.ts:494–506`, `writeReviewArtifacts`).

The reviewer calls `mcp__canon__write_review` (declared in `agents/reviewer.md` `tools:` frontmatter at line 34) to produce both artifacts in one call. The prose body and the structured sidecar are twin outputs of the same write, never written separately.

## The Rule

**1. Human-narrative artifacts are read by humans at HITL gates. They stay prose.**

`DESIGN.md`, the prose body of `REVIEW.md`, and `PLAN.md` are rendered to HTML and opened in the browser before HITL gate presentation. A human reads them. They must never be replaced by structured rows, JSON, or typed schemas. The `feedback_always_render_review_html` obligation stands unconditionally.

**2. Machine-queried state may be typed and queryable.**

Review findings rows (`violations[]`), coverage scores, touched-file lists, budget-debit events, and any orchestrator-consumed signal — these may be typed stores. The `.meta.json` sidecar is the canonical form. New machine-queryable state added to the review pipeline goes into the sidecar, not into the prose body.

**3. The discriminator is consumer type, not artifact role.**

Ask: "Is this artifact read by a HUMAN at a HITL gate, or queried by an agent or orchestrator?"

| Consumer | Format |
|----------|--------|
| Human at a HITL gate (plan approval, review verdict, design approval) | Prose — rendered to HTML, opened in browser |
| Orchestrator or agent querying findings, scores, or coverage | Typed sidecar (`.meta.json`) |

The boundary is per-consumer-type, not per-role. The same `write_review` call produces both consumers' artifacts simultaneously; they must remain distinct files.

## Why This Matters Now

This convention gates the Phase-1 `#2 reviewer-consolidation` build. That build will make parallel review consolidation (the Phase 3 orchestrator fan-out) a QUERY over the existing `.meta.json` sidecars instead of re-reading N fat `REVIEW-N.md` prose files into the orchestrator's context window.

Without this seam convention, a consolidation build might attempt to parse structured findings out of the prose `REVIEW.md` body, or to replace the prose with structured rows — both of which destroy the human-readable HITL artifact and the `feedback_always_render_review_html` obligation.

With this seam convention:
- The consolidation build may freely type-ify and index `REVIEW.meta.json` findings.
- The `REVIEW.md` prose body remains untouched — the human sees the same rendered prose at the HITL gate regardless of how many reviewers ran.

## Applying the Convention When Adding New Artifacts

When designing a new canonical artifact type:

1. **Identify the consumer.** Human at a HITL gate → prose. Orchestrator/agent query → typed sidecar.
2. **Produce both if the artifact serves both consumers.** One `write_*` MCP tool call emitting both files atomically is the canonical pattern (see `write-review.ts:487–508`, `write-implementation-summary.ts:233` for the summary's `.meta.json` sidecar).
3. **Never merge prose into JSON or JSON into prose.** A `.meta.json` that embeds prose for human rendering is a protocol violation. A prose `.md` that embeds structured JSON for machine parsing is equally wrong.

## Verified Physical Locations

| Artifact | File path (relative to workspace root) | Producer |
|----------|----------------------------------------|---------|
| Human-narrative prose | `reviews/REVIEW.md` | `write-review.ts:494` (`writeReviewArtifacts`) |
| Machine-consumed sidecar | `reviews/REVIEW.meta.json` | `write-review.ts:495` (`writeReviewArtifacts`) |
| Step-scoped sidecar | `reviews/REVIEW-{step_id}.meta.json` | `write-review.ts:500` |
| Tool that writes both | `mcp__canon__write_review` | `agents/reviewer.md:34` (`tools:` frontmatter) |

## Examples

**Good — prose body and structured sidecar are twin outputs of one write call:**

```typescript
// The reviewer calls write_review once. The tool writes both artifacts atomically.
await mcp__canon__write_review({
  workspace: WORKSPACE,
  verdict: "approved_with_concerns",
  summary: "Two strong-opinion violations found in ...",
  violations: [{ principle_id: "...", severity: "strong-opinion", ... }],
  honored: ["errors-are-values"],
  score: { rules: { passed: 5, total: 5 }, ... },
  files: ["src/features/orchestration/tools/write-review.ts"],
});
// → writes reviews/REVIEW.md (prose for human at HITL gate)
// → writes reviews/REVIEW.meta.json (typed for orchestrator queries)
```

**Good — consolidator queries the sidecar; renderer reads the prose:**

```typescript
// Consolidator: query structured findings without touching REVIEW.md prose
const meta = JSON.parse(readFileSync("reviews/REVIEW.meta.json", "utf8"));
const violations = meta.violations; // typed, queryable

// Renderer: reads REVIEW.md prose → renders to review.html for human HITL gate
// REVIEW.md is never parsed for structured content — it is for human eyes only
```

**Bad — structured rows embedded in the prose artifact:**

```markdown
<!-- BAD: REVIEW.md body embeds JSON for machine parsing -->
## Violations
```json
[{ "principle_id": "errors-are-values", "severity": "rule", ... }]
```
<!-- This destroys the human-readable prose and the render-to-HTML obligation -->
```

**Bad — prose narrative replacing the structured sidecar:**

```typescript
// BAD: meta.json written as prose instead of typed JSON
writeFileSync("reviews/REVIEW.meta.json", 
  "The reviewer found two violations in the orchestration tools...");
// REVIEW.meta.json must be structured JSON — the orchestrator parses it
```

## Anti-Rationalization

| Excuse | Why It's Wrong | Correct Action |
|--------|---------------|----------------|
| "Embedding JSON in the prose makes it one file — simpler." | One file cannot serve two consumer types. HTML rendering of the prose breaks when it contains raw JSON blocks. | Keep the pair: prose `.md` for humans, `.meta.json` for machines. |
| "I can parse the prose body to extract findings during consolidation." | Prose format is not a contract. Any wording change breaks the parser and the consolidation builds that follow. | Query `REVIEW.meta.json` — its schema is stable and version-controlled. |
| "The sidecar is redundant — everything is in REVIEW.md." | The sidecar is the machine-queryable form. Without it, the consolidator must re-read N prose files into the orchestrator's context window, which is the exact cost this seam eliminates. | Keep both artifacts as twin outputs. |

## Verification

- [ ] Every new `write_*` MCP tool that produces an artifact read by a human at a HITL gate also produces a `.meta.json` sidecar for machine consumption, and the two are written atomically by one tool call.
- [ ] No new code reads `REVIEW.md` body prose to extract structured findings — query `REVIEW.meta.json` instead.
- [ ] No new code writes structured rows, JSON, or typed schemas into the `REVIEW.md` prose body.
- [ ] Any new canonical artifact type (following the managed-artifact-class shape convention) carries both a human-readable prose artifact and a machine-queryable typed sidecar when it serves both consumer types.

## Related

- `[[managed-artifact-class-shape]]` — convention governing how Canon's managed artifact classes are structured; the `.meta.json` sidecar pattern is an instance of the machine-queryable component.
- `[[disk-is-source-of-truth-on-resume]]` — sibling convention governing intra-agent cursor writes; composes with the seam: each incremental reviewer write (`REVIEW.md` prose + `REVIEW.meta.json`) is a valid cursor checkpoint.
- `[[feedback-always-render-review-html]]` — user feedback requiring the renderer spawn at every review HITL gate; this seam convention is the structural guarantee that the prose artifact the renderer reads always exists separately from the machine-queryable sidecar.
