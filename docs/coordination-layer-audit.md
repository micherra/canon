# Coordination Layer Audit — Phase 0

Status: complete.
Owner: Canon maintainers.
Last updated: 2026-04-10.

This document is the Phase 0 audit required by `docs/agent-teams-migration-plan.md` section 6. It enumerates every call site and reference of the six coordination-layer MCP tools that Phase 4 will delete: `drive_flow`, `load_flow`, `init_workspace`, `post_message`, `get_messages`, and `report_result`. It is additive — no existing file is modified.

The audit is intended to scope the eventual deletion, not to prescribe it. Phase 1 does not remove or alter any of these tools.

---

## 1. Tool-by-tool summary

| Tool | Purpose (one line) | Primary handler |
|------|--------------------|-----------------|
| `drive_flow` | Advance the Canon flow state machine one turn: enter current state, ingest agent result, evaluate transitions, emit next `SpawnRequest` / `HitlBreakpoint` / `done` action. | `mcp-server/src/features/orchestration/tools/drive-flow.ts` |
| `load_flow` | Parse and resolve a flow definition (YAML + fragments) into a `ResolvedFlow` object with adjacency graph, spawn instructions, and validation applied. | `mcp-server/src/features/orchestration/tools/load-flow.ts` |
| `init_workspace` | Create or resume a workspace under `.canon/workspaces/<id>/`; run preflight checks; seed `progress.md`; return warnings for stale sessions / file-claim overlap. | `mcp-server/src/features/orchestration/tools/init-workspace.ts` |
| `post_message` | Append a markdown message to a workspace channel (SQLite messages table) for inter-agent coordination. | `mcp-server/src/features/orchestration/tools/post-message.ts` |
| `get_messages` | Read messages from a workspace channel ordered by sequence; optionally includes pending wave events. | `mcp-server/src/features/orchestration/tools/get-messages.ts` |
| `report_result` | Record an agent's state result, evaluate transitions, update the board, apply quality signals (gates, postconditions, violations), and run stuck detection. Called internally by `drive_flow`. | `mcp-server/src/features/orchestration/tools/report-result.ts` |

---

## 2. Registration

All six tools are registered in a single file:

- `mcp-server/src/app/register-orchestration.ts` (≈539 lines), invoked from `registerOrchestrationTools()` at the bottom of the file.

Precise registration call sites:

| Tool | Register line | Import line |
|------|---------------|-------------|
| `load_flow` | `register-orchestration.ts:34` (inside `registerFlowCoreTools`) | `register-orchestration.ts:10` |
| `init_workspace` | `register-orchestration.ts:74` (inside `registerFlowCoreTools`) | `register-orchestration.ts:8` |
| `report_result` | `register-orchestration.ts:219` (inside `registerReportTools`) | `register-orchestration.ts:13` |
| `post_message` | `register-orchestration.ts:381` (inside `registerMessagingTools`) | `register-orchestration.ts:12` |
| `get_messages` | `register-orchestration.ts:419` (inside `registerMessagingTools`) | `register-orchestration.ts:6` |
| `drive_flow` | `register-orchestration.ts:439` (inside `registerDriveFlowTool`) | `register-orchestration.ts:5` |

All six handlers are wrapped with `gatedWrapHandler` (feature-gate check → `wrapHandler` → `ToolResult<T>` per ADR-002).

---

## 3. Orchestration module layout

Root: `mcp-server/src/features/orchestration/`.

### 3.1 `tools/` — MCP tool implementations

Coordination-layer tools (the six under audit):
- `drive-flow.ts` — state machine driver. Supported by `drive-flow-helpers.ts`, `drive-flow-wave.ts`, `drive-flow-wave-lifecycle.ts`.
- `load-flow.ts` — flow loader / validator.
- `init-workspace.ts` — workspace bootstrap.
- `post-message.ts` — message writer.
- `get-messages.ts` — message reader.
- `report-result.ts` — result reporter. Supported by `report-result-board.ts`, `report-result-validation.ts`, `report-result-side-effects.ts`.

Adjacent tools (not in the audit scope but share the orchestration surface):
- `enter-and-prepare-state.ts`, `get-spawn-prompt.ts`, `get-transcript.ts`, `update-board.ts`, `simulate-flow.ts`, `seed-workspace.ts`, `post-event.ts`, `report.ts`, `inject-wave-event.ts`, `resolve-wave-event.ts`, `resolve-after-consultations.ts`, and the typed artifact writers (`write-design-brief.ts`, `write-implementation-summary.ts`, `write-research-synthesis.ts`, `write-review.ts`, `write-plan-index.ts`).

### 3.2 `engine/` — state machine internals

- `transitions.ts`, `convergence.ts`, `effects.ts`, `debate.ts`, `consultation-executor.ts`, `compete.ts`.

### 3.3 `services/` — cross-cutting orchestration services

- `context-budget.ts`, `context-enrichment.ts`, `contract-checker.ts`, `diff-cluster.ts`, `drive-flow-types.ts`, `inject-context.ts`, `kg-context-formatter.ts`, `learn-gate.ts`, `scope-resolver.ts`, `wave-briefing.ts`.

### 3.4 `__tests__/` — 110+ test files

Comprehensive suite; selected per-tool files are listed in section 5.

---

## 4. Shared abstractions the six tools depend on

These will remain after Phase 4 even though the six tools are deleted, because they are used elsewhere:

- **`ResolvedFlowSchema`** (Zod) — single source of truth for flow validation. Re-used by `drive_flow`, `report_result`, and `resolve_after_consultations` as input schema for the flow argument.
- **`gatedWrapHandler` / `wrapHandler`** — middleware enforcing feature gates and typed `ToolResult<T>` envelopes (ADR-002).
- **`ExecutionStore`** — SQLite persistence layer (`domains/workspaces/`). Used by all six tools.
- **`Board` / `syncBoardToStore`** — immutable board state (`domains/board/`). ADR-009a extracts shared sync helper used by `drive_flow` and `report_result`.
- **`Message` type + `writeMessage` / `readMessages`** — inter-agent messaging domain (`domains/messages/`). Post/get.
- **Preflight helpers** — `runPreflightChecks()`, `checkClaimOverlaps()` (file-claims), `tryResumeWorkspace()`.

---

## 5. Per-tool call sites

File paths are relative to repository root. Counts are approximate (ripgrep, case-sensitive, identifier bounded).

### 5.1 `drive_flow`

Primary:
- `mcp-server/src/features/orchestration/tools/drive-flow.ts` — implementation (≈587 LOC).
- `mcp-server/src/features/orchestration/tools/drive-flow-helpers.ts` — helpers (≈537 LOC).
- `mcp-server/src/features/orchestration/tools/drive-flow-wave.ts` — wave handling.
- `mcp-server/src/features/orchestration/tools/drive-flow-wave-lifecycle.ts` — wave lifecycle (≈468 LOC).
- `mcp-server/src/app/register-orchestration.ts:439` — registration.
- `mcp-server/src/features/orchestration/services/drive-flow-types.ts` — `DriveFlowAction`, `DriveFlowInput`, `SpawnRequest`.

Tests:
- `drive-flow.test.ts`, `drive-flow-e2e-wave.test.ts`, `drive-flow-auto-approve.test.ts`, `drive-flow-approval-gates.test.ts`, `drive-flow-flow-events.test.ts`, `drive-flow-wave-gates.test.ts`, `drive-flow-wave-merge.test.ts` (under `mcp-server/src/features/orchestration/__tests__/`).

Documentation / agents / flows:
- `skills/canon/references/canon-orchestrator.md` — orchestrator protocol.
- `CLAUDE.md` — project instructions reference `drive_flow` as part of the state machine loop.
- `docs/reference/canon-reference.md` — MCP tool table entry.
- `agents/*.md` — scattered mentions in agent briefs.

Per-feature count (production files only, not tests, not docs):
- `orchestration/`: ~65 references.
- Elsewhere in `mcp-server/src/features/`: 0 meaningful references.

### 5.2 `load_flow`

Primary:
- `mcp-server/src/features/orchestration/tools/load-flow.ts` — implementation.
- `mcp-server/src/app/register-orchestration.ts:34` — registration.
- Domain schemas: `mcp-server/src/domains/flows/flow-definition-schemas.ts` — `ResolvedFlowSchema` and fragment resolution types.

Tests:
- `__tests__/load-flow*.test.ts` (several).

Cross-feature references:
- `mcp-server/src/features/prompt-pipeline/tool-profiles.ts` — references `load_flow` in tool-profile allowlists.
- `mcp-server/src/features/prompt-pipeline/` — ~5 references total (agent permissioning).

Documentation / agents / flows:
- `skills/canon/references/canon-orchestrator.md` — documents the load → drive loop.
- `CLAUDE.md`, `docs/reference/canon-reference.md`, `flows/README.md`, `flows/SCHEMA.md`.

Per-feature count:
- `orchestration/`: ~40 references.
- `prompt-pipeline/`: ~5 references.

### 5.3 `init_workspace`

Primary:
- `mcp-server/src/features/orchestration/tools/init-workspace.ts` — implementation (≈604 LOC).
- `mcp-server/src/app/register-orchestration.ts:74` — registration (imported as `initWorkspaceFlow`).
- Preflight dependencies: `mcp-server/src/features/orchestration/tools/preflight.ts`, `file-claims.ts`, `seed-workspace.ts`.

Tests:
- `init-workspace-preflight.test.ts`, `init-workspace-seed.test.ts`, `init-workspace-worktree.test.ts`, and several integration tests.

Cross-feature references:
- `mcp-server/src/features/prompt-pipeline/worktree-settings.ts` — references the workspace directory layout created by `init_workspace`.

Documentation / agents / flows:
- `skills/canon/commands/*.md` — user-facing `/canon:init` and similar commands document the tool.
- `CLAUDE.md`, `docs/reference/canon-reference.md`.

Per-feature count:
- `orchestration/`: ~35 references.
- `prompt-pipeline/`: minor (layout reads only).

### 5.4 `post_message`

Primary:
- `mcp-server/src/features/orchestration/tools/post-message.ts` — implementation.
- `mcp-server/src/app/register-orchestration.ts:381` — registration.
- `mcp-server/src/domains/messages/writer.ts` — `writeMessage()` used by handler.

Tests:
- `__tests__/post-message*.test.ts`, `debate.test.ts`, `fanout-integration.test.ts`, `wave-event-lifecycle-integration.test.ts`.

Cross-feature references:
- `mcp-server/src/features/prompt-pipeline/tool-profiles.ts` — allowlist entry (~8 references total in this feature including tests and `inject-coordination.ts`).

Documentation / agents / flows:
- `agents/canon-*.md` — several agent definitions reference `post_message` for coordination.

Per-feature count:
- `orchestration/`: ~22 references.
- `prompt-pipeline/`: ~8 references.

### 5.5 `get_messages`

Primary:
- `mcp-server/src/features/orchestration/tools/get-messages.ts` — implementation.
- `mcp-server/src/app/register-orchestration.ts:419` — registration.
- `mcp-server/src/domains/messages/reader.ts` — `readMessages()`.
- Wave event plumbing: `inject-wave-event.ts`, `resolve-wave-event.ts` (consume the same store).

Tests:
- `get-messages*.test.ts`, `wave-event-lifecycle-integration.test.ts`, `fanout-integration.test.ts`.

Cross-feature references:
- `mcp-server/src/features/prompt-pipeline/tool-profiles.ts` — ~9 references in this feature.

Documentation / agents / flows:
- `agents/canon-*.md` — coordination-related briefs mention `get_messages`.
- `skills/canon/references/canon-orchestrator.md`.

Per-feature count:
- `orchestration/`: ~28 references.
- `prompt-pipeline/`: ~9 references.

### 5.6 `report_result`

Primary:
- `mcp-server/src/features/orchestration/tools/report-result.ts` — implementation (≈354 LOC).
- `mcp-server/src/features/orchestration/tools/report-result-board.ts` — board mutation logic (≈520 LOC).
- `mcp-server/src/features/orchestration/tools/report-result-side-effects.ts` — side effects (≈270 LOC).
- `mcp-server/src/features/orchestration/tools/report-result-validation.ts` — validation.
- `mcp-server/src/app/register-orchestration.ts:219` — registration (`reportResultInputSchema` at lines 98–215).

Called internally by:
- `drive_flow` (composes with `syncBoardToStore()` per ADR-009a).

Tests:
- `report-result-baseline.test.ts`, `report-result-diagnostics.test.ts`, `report-result-quality.test.ts`, `report-result-discovery.test.ts`, and integration tests via `drive_flow` paths.

Documentation / agents / flows:
- `skills/canon/references/canon-orchestrator.md` notes that orchestrators must **not** call `report_result` directly — `drive_flow` calls it internally.
- `CLAUDE.md` reiterates that rule.
- `docs/reference/canon-reference.md`.

Per-feature count:
- `orchestration/`: ~45 references.
- Other features: 0 meaningful references.

---

## 6. Per-feature reference counts (summary)

Counts are production source plus tests under each feature directory. Doc / markdown mentions are excluded from these numbers.

| Feature | `drive_flow` | `load_flow` | `init_workspace` | `post_message` | `get_messages` | `report_result` |
|---------|--------------|-------------|------------------|----------------|----------------|-----------------|
| `orchestration/` | ~65 | ~40 | ~35 | ~22 | ~28 | ~45 |
| `prompt-pipeline/` | 0 | ~5 | minor | ~8 | ~9 | 0 |
| `principles/` | 0 | 0 | 0 | 0 | 0 | 0 |
| `knowledge-graph/` | 0 | 0 | 0 | 0 | 0 | 0 |
| `pr-review/` | 0 | 0 | 0 | 0 | 0 | 0 |
| `file-context/` | 0 | 0 | 0 | 0 | 0 | 0 |
| `diagnostics/` | 0 | 0 | 0 | 0 | 0 | 0 |

### Markdown / documentation mentions (non-source)

| Location | References (all six tools, combined) |
|----------|--------------------------------------|
| `docs/` | ~30 (reference docs, migration plan, historical retros) |
| `agents/` | ~25 (per-role briefs and coordination notes) |
| `flows/` | ~15 (flow authoring guide and fragment docs) |
| `skills/canon/` | ~20 (orchestrator protocol reference, slash-command briefs) |
| `CLAUDE.md` (project root) | ~10 |

Total documentation mentions across the repo: ~100.

---

## 7. Dependency graph between the six tools

```
load_flow                          (no deps; returns ResolvedFlow)
   │
   ▼
drive_flow  ──►  report_result     (drive_flow calls report_result internally)
   │
   ├── reads   post_message / get_messages  (via wave events plumbing)
   │
   └── uses    init_workspace output (expects workspace_id to exist)

init_workspace                      (no deps on the other five)
   │
   ▼
post_message  ◄──► get_messages     (share the same messages table)
```

---

## 8. Migration readiness observations

1. All six tools already return a typed `ToolResult<T>` with discriminated `error_code` values (ADR-002). Replacing them with non-MCP helpers or deleting them will not change any return-type contracts outside `mcp-server/src/app/`.
2. No file system writes happen outside `.canon/workspaces/<id>/` (confirmed during recon; also required by the principles layer). Phase 1 additions honor the same constraint.
3. Cross-tool state is carried entirely through `ExecutionStore` (SQLite), not shared in-process state. Swapping the state machine for runbook-driven agent teams leaves the store schema intact.
4. The coordination layer is almost entirely self-contained in `orchestration/`. The only non-trivial cross-feature caller is `prompt-pipeline/` (tool-profile allowlists and worktree settings) — about 30 references total — which will need either an allowlist update or a shim when Phase 4 deletes the tools.
5. `report_result` is not reachable through the documented orchestrator protocol — only `drive_flow` calls it. That makes its deletion blast radius smaller than the headline LOC count suggests.
6. `post_message` / `get_messages` are used by both the wave-event plumbing and the agent mailbox pattern. Phase 4 must replace both use cases (wave events via runbook branching in Phase 3, mailbox via teammate-message UserPromptSubmit envelopes already present in Claude Code agent teams).

---

## 9. Phase 4 deletion scope (estimate)

Production LOC in `orchestration/tools/` that would be removed if all six tools and their direct helpers were deleted:

| File | LOC (approx.) |
|------|---------------|
| `drive-flow.ts` | 587 |
| `drive-flow-helpers.ts` | 537 |
| `drive-flow-wave-lifecycle.ts` | 468 |
| `drive-flow-wave.ts` | (not measured here) |
| `init-workspace.ts` | 604 |
| `report-result.ts` | 354 |
| `report-result-board.ts` | 520 |
| `report-result-side-effects.ts` | 270 |
| `report-result-validation.ts` | (not measured here) |
| `load-flow.ts` | ~100 |
| `post-message.ts` | ~50 |
| `get-messages.ts` | ~50 |

Rough direct deletion: ≈3,540 LOC across the production files listed. The migration plan's 30–40% estimate for `mcp-server/src/features/orchestration/` (section 6, Phase 4) is consistent with this count once the 110+ test files are also considered for trimming.

The numbers in this section are a snapshot for planning; Phase 4 must re-measure immediately before deletion.

---

## 10. Appendix — audit methodology

- Recon performed 2026-04-10 on branch `claude/canon-agent-teams-migration-gICh6`.
- Tool used: `ripgrep` via the Grep interface, case-sensitive, identifier-bounded.
- "References" means identifier appearances in source (`.ts`) or documentation (`.md` / `.yaml`). Comments counted when the identifier appears as a bare word.
- LOC figures are approximate and taken from file-size snapshots, not normalized for blank lines or comments.
- No file was modified by this audit.
