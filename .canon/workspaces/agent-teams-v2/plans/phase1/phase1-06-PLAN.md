---
task_id: "phase1-06"
wave: 2
depends_on:
  - "phase1-00"
  - "phase1-01"
  - "phase1-02"
  - "phase1-03"
  - "phase1-04"
files:
  - mcp-server/src/features/orchestration/tools/orchestration-journal.ts
  - mcp-server/src/app/register-orchestration.ts
  - mcp-server/src/features/orchestration/tools/__tests__/orchestration-journal.test.ts
principles:
  - errors-are-values
  - thin-handlers
  - agent-tdd-required
domains:
  - mcp-server
---

## Task: Implement orchestration journal MCP tools

### Action

Write `mcp-server/src/features/orchestration/tools/orchestration-journal.ts` (~50-80 lines) implementing two MCP tools: `log_step` and `verify_completion`. Register them in `register-orchestration.ts` behind `CANON_AGENT_TEAMS_MODE=on`.

#### 1. Implement `orchestration-journal.ts`

The file should export two handler functions:

```typescript
// orchestration-journal.ts

import { toolOk, toolError, type ToolResult } from "@shared/lib/tool-result.ts";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

interface JournalStep {
  step_id: string;
  agent_type: string | null;
  artifacts_expected: string[];
  status: "planned" | "started" | "completed" | "skipped";
  started_at?: string;
  completed_at?: string;
  mcp_tools_called?: string[];
}

interface Journal {
  version: 1;
  workspace: string;
  steps: JournalStep[];
}
```

**`logStep` function:**

Input schema:
- `workspace: string` (required) — workspace path
- `step_id: string` (required) — step ID from the runbook
- `agent_type: string | null` (optional) — agent definition name, null for gate-only steps
- `artifacts_expected: string[]` (optional, default []) — expected artifact paths relative to workspace
- `status: "planned" | "started" | "completed" | "skipped"` (required)
- `mcp_tools_called: string[]` (optional) — MCP tools the lead called for this step

Behavior:
1. Read `${workspace}/journal.json` if it exists; otherwise initialize empty journal.
2. Find existing step entry by `step_id`. If found, update its `status` and timestamps. If not found, create a new entry.
3. When `status` is `"started"`, set `started_at` to ISO timestamp.
4. When `status` is `"completed"`, set `completed_at` to ISO timestamp.
5. Write updated journal back to `${workspace}/journal.json`.
6. Return `{ ok: true, step_id, status }`.

Error handling:
- If `workspace` does not exist, return `toolError("WORKSPACE_NOT_FOUND", ...)`.
- If `step_id` is empty, return `toolError("INVALID_INPUT", ...)`.

**`verifyCompletion` function:**

Input schema:
- `workspace: string` (required) — workspace path

Behavior:
1. Read `${workspace}/journal.json`. If it does not exist, return `toolError("WORKSPACE_NOT_FOUND", "No journal found at workspace")`.
2. Compute:
   - `steps_logged`: total steps in journal
   - `steps_completed`: steps with status "completed"
   - `steps_missing`: steps with status "started" but not "completed" (started but abandoned)
   - `steps_skipped`: steps with status "skipped"
   - `artifacts_expected`: all `artifacts_expected` from completed steps, flattened
   - `artifacts_missing`: artifacts from `artifacts_expected` that do not exist on disk (resolve paths relative to workspace, allow glob patterns in artifact paths like `plans/${slug}/*.md`)
3. Return:
```typescript
{
  ok: true,
  steps_logged: number,
  steps_completed: number,
  steps_missing: Array<{ step_id: string; status: string }>,
  steps_skipped: string[],
  artifacts_expected: string[],
  artifacts_missing: string[],
  complete: boolean  // true when steps_missing is empty AND artifacts_missing is empty
}
```

#### 2. Register in `register-orchestration.ts`

Add a new function `registerJournalTools()` that registers both tools. Gate it behind `CANON_AGENT_TEAMS_MODE`:

```typescript
function registerJournalTools(): void {
  if (process.env.CANON_AGENT_TEAMS_MODE !== "on") return;

  server.registerTool(
    "log_step",
    {
      description: "Log a step in the orchestration journal. Records step execution for audit trail and completion verification.",
      inputSchema: {
        workspace: z.string().describe("Workspace directory path"),
        step_id: z.string().describe("Step ID from the runbook"),
        agent_type: z.string().nullable().optional().describe("Agent definition name, null for gate-only steps"),
        artifacts_expected: z.array(z.string()).optional().describe("Expected artifact paths relative to workspace"),
        status: z.enum(["planned", "started", "completed", "skipped"]).describe("Step execution status"),
        mcp_tools_called: z.array(z.string()).optional().describe("MCP tools the lead called for this step"),
      },
    },
    wrapHandler(async (input) => logStep(input)),
  );

  server.registerTool(
    "verify_completion",
    {
      description: "Verify flow completion by checking the orchestration journal. Returns steps logged, steps missing, and artifacts missing.",
      inputSchema: {
        workspace: z.string().describe("Workspace directory path"),
      },
    },
    wrapHandler(async (input) => verifyCompletion(input)),
  );
}
```

Call `registerJournalTools()` from `registerOrchestrationTools()`.

#### 3. Write tests

Create `mcp-server/src/features/orchestration/tools/__tests__/orchestration-journal.test.ts`:

Tests to cover:
1. `logStep` — creates journal.json on first call
2. `logStep` — updates existing step status from planned → started → completed
3. `logStep` — adds timestamps on started and completed
4. `logStep` — returns WORKSPACE_NOT_FOUND for nonexistent workspace
5. `logStep` — returns INVALID_INPUT for empty step_id
6. `verifyCompletion` — returns complete: true when all steps completed and artifacts exist
7. `verifyCompletion` — detects steps_missing (started but not completed)
8. `verifyCompletion` — detects artifacts_missing when expected files don't exist
9. `verifyCompletion` — returns WORKSPACE_NOT_FOUND when no journal
10. `verifyCompletion` — handles skipped steps correctly (not counted as missing)

Use `vitest` and `tmp` directories for workspace fixtures. Follow existing test patterns in `mcp-server/src/features/orchestration/tools/__tests__/`.

### Canon principles to apply
- **errors-are-values**: Both functions return `ToolResult<T>` — never throw for expected conditions. Use `toolError()` and `toolOk()`.
- **thin-handlers**: Registration code in `register-orchestration.ts` is thin — delegates to handler functions in `orchestration-journal.ts`.
- **agent-tdd-required**: Write tests alongside the implementation. Each function gets at least 5 test cases.

### Risk mitigations
- **Feature flag isolation**: The `CANON_AGENT_TEAMS_MODE !== "on"` guard ensures these tools are invisible when the flag is off. Verify this in tests.
- **Concurrent access**: Journal writes should be atomic (write to temp, rename). Follow the pattern from existing Canon workspace files.
- **Glob patterns in artifacts**: `artifacts_expected` may contain `${slug}` or glob patterns. The verification must handle these — resolve variables from workspace context or skip unresolvable patterns.

### Tests to write
- `mcp-server/src/features/orchestration/tools/__tests__/orchestration-journal.test.ts`: 10 test cases as described above

### Verify
1. All new tests pass: `cd mcp-server && npx vitest run src/features/orchestration/tools/__tests__/orchestration-journal.test.ts`
2. Existing tests still pass: `cd mcp-server && npm test`
3. Build passes: `cd mcp-server && npm run build`
4. Feature flag gating verified: tools not registered when `CANON_AGENT_TEAMS_MODE` is unset or `off`
5. `journal.json` written to workspace directory with correct structure

### Done when
- `orchestration-journal.ts` exists with `logStep` and `verifyCompletion` functions (~50-80 lines)
- Both tools registered in `register-orchestration.ts` behind `CANON_AGENT_TEAMS_MODE=on`
- 10 test cases written and passing
- Full test suite passes
- Build passes
- Feature flag correctly gates tool registration
