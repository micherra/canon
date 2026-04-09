# orchestration/ — Flow Execution Engine

This bounded context owns Canon's flow state machine runtime and every MCP tool the orchestrator uses to drive a build session. It is the largest feature in the codebase.

## What this context owns

- **Flow engine** (`engine/`) — state transition evaluation, convergence enforcement, effects, competitive flows, debate protocol, consultation execution
- **Orchestration tools** (`tools/`) — all harness MCP tools: `drive_flow`, `init_workspace`, `load_flow`, `report_result`, `update_board`, `post_message`, `get_messages`, `inject_wave_event`, `resolve_wave_event`, `resolve_after_consultations`, `record_agent_metrics`, `post_event`, `write_plan_index`, `simulate_flow`, and the artifact-write tools (`write_design_brief`, `write_implementation_summary`, `write_research_synthesis`, `write_review`, `write_test_report`)
- **Orchestration services** (`services/`) — context budget, prompt enrichment, contract checking, diff clustering, context injection, KG context formatting, learn gate evaluation, scope resolution, wave briefing assembly

## What this context does NOT own

- Board state schema and persistence types — owned by `@domains/board`
- Flow definition types (`ResolvedFlow`, `StateDefinition`, etc.) — owned by `@domains/flows`
- Workspace file I/O primitives — owned by `@domains/workspaces`
- Knowledge graph querying — owned by `features/knowledge-graph`
- Prompt pipeline and tool-profile resolution — owned by `features/prompt-pipeline`
- Principle loading and matching — owned by `features/principles`

## Public interface

Key tools exported for registration in `src/app/index.ts`:

```typescript
// State machine driver
import { driveFlow } from "@features/orchestration/tools/drive-flow.ts";

// Workspace lifecycle
import { initWorkspace } from "@features/orchestration/tools/init-workspace.ts";
import { loadFlow } from "@features/orchestration/tools/load-flow.ts";

// Agent result recording
import { reportResult } from "@features/orchestration/tools/report-result.ts";
import { recordAgentMetrics } from "@features/orchestration/tools/record-agent-metrics.ts";

// Board mutation
import { updateBoard } from "@features/orchestration/tools/update-board.ts";

// Messaging
import { postMessage } from "@features/orchestration/tools/post-message.ts";
import { getMessages } from "@features/orchestration/tools/get-messages.ts";

// Wave events
import { injectWaveEvent } from "@features/orchestration/tools/inject-wave-event.ts";
import { resolveWaveEvent } from "@features/orchestration/tools/resolve-wave-event.ts";
import { resolveAfterConsultations } from "@features/orchestration/tools/resolve-after-consultations.ts";
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

If the tool needs a new effect type, add it to `engine/effects.ts` and the `EffectTypeSchema` in `@domains/flows`. TypeScript's exhaustive switch will catch missing implementations at build time.
