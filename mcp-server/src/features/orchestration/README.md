# orchestration/ — Orchestration Runtime

This bounded context owns Canon's orchestration runtime and every MCP tool the orchestrator uses to drive a build session.

## What this context owns

- **Orchestration tools** (`tools/`) — all harness MCP tools: `init_workspace`, `log_step`, `batch_log_steps`, `capture_transcript`, `get_transcript`, `record_agent_metrics`, `post_event`, `write_plan_index`, `resolve_agent_skills`, `invoke_janitor`, `open_artifact`, `present_artifact`, `report`, and the artifact-write tools (`write_implementation_summary`, `write_review`, `write_test_report`)
- **Orchestration services** (`services/`) — context budget, prompt enrichment, contract checking, diff clustering, context injection, KG context formatting, learn gate evaluation, scope resolution, wave briefing assembly

## What this context does NOT own

- Board state schema and persistence types — owned by `@domains/board`
- Flow definition types (`ResolvedFlow`, `StateDefinition`, etc.) — owned by `@domains/flows`
- Workspace file I/O primitives — owned by `@domains/workspaces`
- Knowledge graph querying — owned by `features/knowledge-graph`
- Principle loading and matching — owned by `features/principles`

## Public interface

Key tools exported for registration in `src/app/index.ts`:

```typescript
// Workspace lifecycle
import { initWorkspace } from "@features/orchestration/tools/init-workspace.ts";

// Step journaling
import { logStep, batchLogSteps } from "@features/orchestration/tools/orchestration-journal.ts";

// Agent metrics and activity
import { recordAgentMetrics } from "@features/orchestration/tools/record-agent-metrics.ts";
import { postEvent } from "@features/orchestration/tools/post-event.ts";

// Plan and artifact writing
import { writePlanIndex } from "@features/orchestration/tools/write-plan-index.ts";
import { writeImplementationSummary } from "@features/orchestration/tools/write-implementation-summary.ts";
import { writeReview } from "@features/orchestration/tools/write-review.ts";
import { writeTestReport } from "@features/orchestration/tools/write-test-report.ts";

// Agent skill resolution
import { resolveAgentSkills } from "@features/orchestration/tools/resolve-agent-skills.ts";

// Transcript capture
import { captureTranscript } from "@features/orchestration/tools/capture-transcript.ts";
import { getTranscript } from "@features/orchestration/tools/get-transcript.ts";
```

All tool functions return `ToolResult<T>` (see `@shared/lib/tool-result.ts`). Expected errors are never thrown — they are returned as typed `CanonToolError` values.

## Allowed dependencies

| Allowed | Disallowed |
|---------|-----------|
| `@domains/*` — flow, board, workspace, message types | Other features (e.g., `@features/principles/`) |
| `@shared/*` — utilities, constants, error handling | Direct imports from `platform/` internals |
| `@graph/*` — KG querying for context enrichment | Relative imports crossing feature boundaries |
| External npm packages (`zod`, `gray-matter`, `better-sqlite3`) | |

The KG import (`@graph/*`) is permitted specifically for the `context-enrichment.ts` and `learn-gate.ts` services, which need file metrics for prompt assembly. All other features that need KG data should go through `@domains/*` types.

## Adding a new orchestration tool

1. Create `tools/{tool-name}.ts` implementing the handler logic.
2. Extract non-trivial logic into `services/` — keep the handler thin.
3. Wrap the handler with `wrapHandler` from `@shared/lib/wrap-handler.ts`.
4. Return `ToolResult<T>` for expected errors; never throw for expected conditions.
5. Register the tool in `src/app/index.ts`.
6. Add tests in `__tests__/`.
