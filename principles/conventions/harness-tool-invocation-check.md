---
id: harness-tool-invocation-check
title: A Harness Built-In Capability Grant Requires Runtime Invocation Verification
severity: convention
scope:
  layers: []
  file_patterns:
    - "agents/*.md"
    - "CLAUDE.md"
---

When a harness built-in tool (any tool not registered in `mcp-server/src/app/register-*.ts` — e.g., `LSP`, `Skill`, `PushNotification`, `WebFetch`, `CronCreate`, `ScheduleWakeup`) is added to an agent's `tools:` allowlist, the build MUST include an acceptance criterion requiring a runtime invocation verification. Presence in the allowlist and absence of a codebase grep hit are both insufficient — only actual invocation in a spawned subagent can confirm the tool is callable.

## Rationale

There is a gap between "in allowlist" and "functionally invocable" that static analysis cannot see:

- **PATH dependencies**: A tool may require an external binary (e.g., `typescript-language-server`) that is not on PATH in the agent's environment.
- **Operation set mismatch**: A tool may exist but lack the specific operation needed (e.g., `LSP` has no `getDiagnostics` — a structural absence invisible to any grep or manifest inspection).
- **Permission gates**: A second gate (e.g., `permissions.allow` Self-Modification classifier) may block tool use even when the tool is in the allowlist. The agent cannot self-widen this gate.
- **Session-scope-only primitives**: Some harness tools (`CronCreate`, `ScheduleWakeup`) are orchestrator-session primitives that produce zero codebase grep hits — they are real and callable, but no source registration exists to inspect.

Two consecutive builds (PR #366, PR #369) added harness tools to agent allowlists and shipped without confirming runtime invocability. In both cases the gap was discovered at implementation time rather than at design time.

## The Rule

**Wiring-task enrichment addendum** — this check is additive to, not a replacement for, the existing wiring-task enrichment (tools: frontmatter `awk` verification + `register-*.ts` grep for MCP tools). Both checks are required. For harness built-ins the `register-*.ts` check is inapplicable — skip it and run only this invocation check.

When granting a harness built-in tool:

1. Spawn a probe agent inside the build worktree with the tool in its `tools:` allowlist.
2. The probe must call the tool with a minimal real input and report the verbatim response.
3. Accept the grant as fully invocable only if the tool returns a non-error response.
4. If the probe is structurally impossible (the spawning agent lacks `Agent` tool, or a permission gate blocks invocation), record the constraint honestly and degrade the grant to guidance-only — do NOT overclaim runtime invocability.
5. Document the probe result in the build SUMMARY. If degraded, state what the tool can and cannot do in the spawned-agent context.

## Relationship to Sibling Conventions

This convention is a **sibling** of `probe-before-build-invoke-not-infer`, not a duplicate. The distinction is scope:

| Convention | Scope | When it fires |
|-----------|-------|---------------|
| `probe-before-build-invoke-not-infer` | Pre-design probe for external SDK/protocol/hook assumptions in DESIGN.md | Before design freeze, when ASSUMPTIONS have `confidence: medium` or `confidence: unknown` |
| `harness-tool-invocation-check` (this) | Runtime invocation check for harness built-in tool grants | At implementation time, when adding a tool to an agent `tools:` allowlist |

Both share the same underlying principle — **invocation is the only valid proof of availability** — but apply at different phases and to different artifact types. Cross-reference both when a build involves harness tool grants that are also load-bearing design assumptions.

## Evidence

| Instance | Build | Tool granted | What static analysis showed | What runtime invocation revealed |
|----------|-------|-------------|----------------------------|----------------------------------|
| 1 | PR #366 | `LSP` added to 3 agents | Tool in allowlist; no `register-*.ts` entry (expected for harness built-ins) | `typescript-language-server` NOT on PATH; `LSP` operation set = `{ listFiles, getReferences, findDefinition }` — no `getDiagnostics`. Grant scoped to navigation-only. |
| 2 | PR #369 | `Skill` added to architect + learner | Tool in allowlist | `permissions.allow` Self-Modification classifier blocked runtime invocation; agent cannot self-widen. Delivered as guidance-only. |

Both instances were resolved correctly (honest degradation + documented SUMMARY) but only after discovering the gap at implementation time — the probe would have surfaced both before any code shipped.

**Note on zero-grep primitives**: `CronCreate` and `ScheduleWakeup` are real Canon harness primitives that return zero hits when grepped across the codebase — they are orchestrator-session tools, not registered MCP tools, so no source artifact documents them. Invocation in a spawned agent is the only way to confirm their behavior and availability in a given context. This reinforces why grep-absence is not evidence of non-existence or non-functionality for harness built-ins.

## Examples

**Bad — grant accepted without invocation probe:**

```yaml
# agents/engineer.md tools: allowlist
tools:
  - LSP
# No probe run. Docs shipped claiming getDiagnostics is available.
# Actual result: operation does not exist.
```

**Good — probe run before shipping:**

```
# Orchestrator spawns probe agent with LSP in tools: allowlist
Probe invokes: LSP.listFiles({ workspacePath: worktreePath })
Result: typescript-language-server NOT found on PATH
Alternative: LSP operation set confirmed as { listFiles, getReferences, findDefinition }
Grant scoped to navigation-only. getDiagnostics removed from usage docs.
PROBE-FINDINGS.md committed. SUMMARY documents the constraint.
```

**Good — honest degradation when probe is structurally impossible:**

```
# Engineer lacks Agent tool — cannot spawn subprobe.
# Orchestrator notes: permission gate blocks Skill invocation.
# SUMMARY: "Skill tool added to allowlist but runtime invocation blocked by
#            permissions.allow Self-Modification classifier. Delivered as
#            guidance-only — agents see the tool but cannot invoke it without
#            human config change."
```

## Anti-Rationalization

| Excuse | Why It's Wrong | Correct Action |
|--------|---------------|----------------|
| "The tool is in the allowlist — it must be available." | Allowlist presence confirms the harness won't reject the tool name. It says nothing about PATH, operation set, or secondary permission gates. | Run an invocation probe. |
| "There are no codebase grep hits, so it must not exist." | Harness session-scope primitives (`CronCreate`, `ScheduleWakeup`) have no source registration. Zero grep hits = no source artifact, not non-existence. | Invocation is the only test that matters. |
| "The probe adds a build step." | The probe is a throwaway agent call taking seconds. The alternative — shipping incorrect usage docs to downstream agents — costs rework across every build that relies on those docs. | Run the probe. |
| "It worked in the last build / last session." | Environment, PATH, tool versions, and permission configurations change. A past result is not a current probe. | Re-probe when the assumption is load-bearing for the current build. |

## Verification

- [ ] Every build that adds a harness built-in to an agent's `tools:` allowlist includes a runtime invocation AC and probe result in the SUMMARY.
- [ ] If the probe is structurally impossible, the SUMMARY documents the constraint honestly and the grant is labeled guidance-only — not overclaimed as invocable.
- [ ] Zero codebase-grep hits for a harness tool name are never interpreted as evidence that the tool does not exist or is non-functional.
