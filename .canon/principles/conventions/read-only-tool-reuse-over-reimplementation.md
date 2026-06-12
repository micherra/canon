---
id: read-only-tool-reuse-over-reimplementation
title: New MCP Tools Must Reuse Existing Internal Helpers Rather Than Reimplementing Their Logic
severity: convention
scope:
  layers:
    - features
  file_patterns:
    - "mcp-server/src/**"
tags:
  - architecture
  - maintainability
  - mcp
  - no-duplication
---

When adding a new MCP tool that needs to query or compute something that existing internal functions already perform, import and call those functions from the new tool file. The new tool adds only: schema definition, input validation, and error mapping — no duplicate logic.

If the target file would exceed the 600-line soft limit, extract the new tool to its own file and import the needed helpers. The pattern is "extract-but-reuse": a new file that delegates to existing internals rather than replicating them.

## Rationale

Reimplementing detection or query logic inside a new tool creates two parallel implementations of the same behavior. Divergence is inevitable: one path is maintained, the other drifts. When a bug is found in one, the other may silently retain it. When requirements change, both must be updated.

The cost of reimplementation is not just the extra lines — it is the maintenance contract for two logic paths where one would do. A new MCP tool is a surface change (new schema, new handler registration) over an existing internal capability. It should expose the capability, not duplicate it.

Behavioral instructions to reuse helpers ("remember to call X instead of writing your own Y") have 0% reliability under delivery pressure. The correct enforcement is structural: the new tool imports the existing helper. If the helper does not exist, extract it from the existing code first (so it is reusable), then call it from the new tool.

## Examples

**Bad — reimplemented artifact detection inside a new MCP tool:**

```typescript
// reconcile-workspace.ts — reimplemented instead of reused
async function reconcileWorkspace(input: ReconcileInput): Promise<ToolResult<ReconcileResult>> {
  // Duplicates logic from orchestration-journal.ts
  const journal = JSON.parse(await readFile(join(input.workspace, "journal.json"), "utf8"));
  const steps = journal.steps.filter((s: Step) => s.status !== "completed");
  // ... more logic that already exists in readJournal + scanArtifactList ...
}
```

**Good — delegates to existing internal helpers:**

```typescript
// reconcile-workspace.ts — imports and calls existing internal functions
import { readJournal } from "../services/orchestration-journal.js";
import { scanArtifactList } from "../services/artifact-matching.js";

async function reconcileWorkspace(input: ReconcileInput): Promise<ToolResult<ReconcileResult>> {
  const journal = await readJournal(input.workspace);          // reuse — no duplication
  const artifacts = await scanArtifactList(input.workspace);  // reuse — no duplication

  const incompleteSteps = detectIncompleteSteps(journal, artifacts); // new logic lives here
  return ok({ incomplete_steps: incompleteSteps, needs_recovery: incompleteSteps.length > 0 });
}
```

The new tool adds: the `detectIncompleteSteps` composition and the MCP schema/handler wiring. It does not add: journal parsing, artifact scanning, or any logic that already existed.

**Good — backward-compatible extension over a new duplicate function:**

When a related operation needs a new parameter, extend the existing function with an optional parameter rather than creating a parallel function:

```typescript
// Before: captureTranscript(input: CaptureInput)
// After: captureTranscript(input: CaptureInput & { source_path?: string; persist_path?: boolean })
// The extension adds capability without creating captureTranscriptForRecovery as a separate function.
```

**Confirmed instances in this codebase:**

| Pattern | Instance | Outcome |
|---------|----------|---------|
| Extract-but-reuse | `reconcile-workspace.ts` imports `readJournal` + `scanArtifactList` from `orchestration-journal.ts` | Zero duplicate detection logic; tool adds only schema and composition |
| Backward-compatible extension | `captureTranscript` extended with `source_path`/`persist_path` params instead of a new `captureTranscriptForRecovery` function | One function, one maintenance path |

Both instances were explicitly flagged as Canon alignment points in their respective DESIGN.md artifacts (decisions `handoff-03` and `handoff-05`).

## Exceptions

When no existing internal function covers the required behavior — the new tool genuinely introduces novel logic — implement it in the tool file. In this case, consider whether the logic belongs in a shared service file first (for future reuse) before placing it directly in the tool handler.

When two tools share superficially similar names but meaningfully different semantics (e.g., `readJournal` vs. a new `readJournalForExport` with different output shaping), a new function is warranted. But: the new function should call the existing one and transform its output, not re-read the same file independently.

**Related:** `functions-do-one-thing` — extracting reusable helpers keeps each function focused on one responsibility. `pure-io-service-split` — helpers extracted for reuse are typically the I/O companion layer; tools call the pure or I/O helper without duplicating either. `compute-effect-separation` — when a helper is extracted for reuse, it should already satisfy the compute/effect separation; a new tool that calls it inherits that separation for free.

**Not a duplicate of:** general DRY or no-duplication guidelines. This convention is specifically about MCP tool authoring in `mcp-server/src/**` and targets the pattern of reimplementing detection/query logic that already exists in the codebase's internal service layer. The enforcement mechanism is structural import, not review guidance.

## Anti-Rationalization

| Excuse | Why It's Wrong | Correct Action |
|--------|---------------|----------------|
| "It's easier to just re-implement — the existing function has more than I need." | Two implementations diverge. The cost is paid when they diverge in a bug, not at authoring time. | Import the existing function and ignore the extra data, or refactor it to accept a narrower input. |
| "The existing function is in a large file — extracting it creates too much churn." | The extraction is a one-time cost; the maintenance of two diverged implementations is a recurring cost. | Extract the needed function to a shared location, then call it from both the original and the new tool. |
| "I'll note the duplication and clean it up later." | "Later" means the second implementation becomes the de facto version when the first one gets fixed. | Reuse now. One implementation. |
| "The new tool needs to work slightly differently." | "Slightly differently" is a parameter. Add an optional parameter to the existing function, or extract a configurable variant that both callers use. | Extend the existing function; do not fork it. |

## Verification

- [ ] Every new MCP tool that queries or computes existing behavior calls an existing internal function rather than re-implementing the logic.
- [ ] The new tool file contains: schema definition, input validation, error mapping, and at most minor composition logic — no substantial logic that duplicates existing services.
- [ ] When a new parameter is needed, the existing function is extended backward-compatibly rather than a new parallel function created.
- [ ] Any new logic in the tool file belongs there (novel behavior) and is not a copy of logic already present in `services/` or `shared/`.
