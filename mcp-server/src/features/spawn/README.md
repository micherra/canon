# features/spawn — Canon spawn-prompt assembly

Phase 1 of the Canon → agent teams migration. This module is a **pure
library** that assembles spawn prompts for teammates in agent-teams mode.
It has no MCP tool surface and performs no I/O.

## Why it exists

In Claude Code agent teams, teammate sessions are isolated from the lead
and do **not** observe `UserPromptSubmit` or `SessionStart` hooks. The
**only** reliable context channel into a teammate is the spawn prompt at
creation time. See `docs/agent-teams-migration-plan.md` §1 for the
experimental evidence.

This module centralizes that assembly step so that:

1. The lead-mode orchestrator (`features/orchestration/lead-mode.ts`) can
   produce consistent, reviewable spawn prompts regardless of which
   runbook is running.
2. Callers never hand-write prompts inline — context shaping evolves in
   one place.
3. The output is deterministic given its input, making it unit-testable
   with fixtures.

## Exported surface

```ts
import {
  assembleSpawnPrompt,
  getRoleArtifactContract,
  CANON_ROLES,
  type CanonRole,
  type TaskType,
  type UpstreamArtifactRef,
  type AssembleSpawnPromptInput,
} from "@features/spawn/index.ts";
```

### `assembleSpawnPrompt(input)`

```ts
function assembleSpawnPrompt(input: {
  role: CanonRole;
  task_type: TaskType;
  target_files: string[];
  upstream_artifact_refs: UpstreamArtifactRef[];
  workspace_id: string;
}): string;
```

Returns a fully-formed markdown prompt string with these sections:

1. **Role brief** — task-type guidance tailored to the role.
2. **Target files** — the files the teammate is expected to read or modify.
3. **Upstream artifacts** — references to artifacts produced by earlier
   steps in the runbook.
4. **Canon principles** — reminder to consult the principles layer.
5. **Task-completion contract** — the artifact the role must produce and
   where it must land on disk. This section is what the
   `TaskCompleted` hook enforces.

### `getRoleArtifactContract(role)`

Returns the canonical artifact contract for a role: label, id, path, and
optional template hint. Used by the orchestrator and runbook loaders that
need the path without running the full assembler.

### `CANON_ROLES`

Frozen list of all roles this module supports. Matches `agents/*.md`.

## What it deliberately does NOT do

- No filesystem I/O — principles, file contents, and conventions are not
  loaded here. Callers that need to inline principle text should resolve
  it and pass it through the task type or upstream artifacts path.
- No MCP tool registration — importing this module has no side effects.
- No branching runbook logic — spawn prompts are per-step; runbook walking
  is `lead-mode.ts`'s job.

## Testing

Unit tests live under `__tests__/assemble-spawn-prompt.test.ts`. Every
role has a fixture covering the completion contract. Tests assert on
structural markers (section headings, artifact ids, paths) rather than
full-string equality so that prose tweaks don't fail the suite.

Run them with:

```bash
cd mcp-server
npm test -- spawn
```

## Feature-flag status

This module is compiled and importable regardless of
`CANON_AGENT_TEAMS_MODE`. It has no side effects, so the only cost of
keeping it always-available is a small bundle increase. The flag gates
the call sites in `lead-mode.ts`, not this library.
