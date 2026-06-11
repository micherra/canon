---
id: probe-before-build-invoke-not-infer
title: Probe External Contracts Before Design Freeze — Invoke, Don't Infer
severity: convention
scope:
  layers: []
  file_patterns:
    - "**/plans/**/DESIGN.md"
    - "**/plans/**/PROBE-FINDINGS.md"
    - "plans/**/DESIGN.md"
    - "plans/**/PROBE-FINDINGS.md"
tags: []
---

When a design's ASSUMPTIONS section carries `confidence: medium` or `confidence: unknown` about external SDK behavior, protocol timing or ordering, or existing hook/script behavior, a throwaway empirical probe MUST run before design freeze. The probe must actually invoke the capability — inferring a result from environment inspection is not a probe. When the probing agent structurally cannot run the probe, the orchestrator must take over.

## Rationale

Design assumptions that are not empirically verified carry hidden implementation risk. When an architect writes "the client will declare `roots` capability over HTTP" with `confidence: medium`, that claim may be correct or wrong — but only actual invocation can tell. The two failure modes this convention prevents:

**Failure mode 1 — Wrong assumption propagates into implementation.** PR #342 (HTTP Epic Phase 2) correctly ran an empirical probe before design freeze. The probe discovered that macOS resolves `/tmp/...` as `/private/tmp/...` via symlink. Without the probe, the scope-key normalization obligation would have shipped silently — the same bug class later appeared at the eviction cache-key seam and required adversarial effort to catch.

**Failure mode 2 — Inference substitutes for invocation.** PR #366 required an LSP capability probe. The engineer, lacking the `Agent` tool and `LSP` in its own `tools:` allowlist, inferred the probe result: "plugin cache exists + tool not blocked at harness → CONSTRAINED." This inference was wrong in two ways simultaneously: (1) `typescript-language-server` was NOT on PATH (the real result would have been FAIL, not CONSTRAINED); (2) the `LSP` tool has no `getDiagnostics` operation — a structural absence invisible to any form of environment inspection. The orchestrator ran the actual probe and discovered both facts before incorrect usage docs shipped to three agents.

The pattern recurs. Every time an assumption is written down rather than measured, the cost to fix it multiplies: it may flow through design, implementation, tests, and reviewer comments before anyone discovers it was wrong.

## The Two-Part Rule

**Part 1 — Pre-design probe for medium/unknown confidence assumptions.**

When a design ASSUMPTIONS section contains any claim with `confidence: medium` or `confidence: unknown` about:
- External SDK method ordering, timing, availability, or response format
- Protocol behavior not verified against the actual client/server version in use
- Hook or script behavior asserted from observation rather than direct code reading

...a throwaway empirical probe must run before the architect finalizes DESIGN.md. The probe exercises exactly the contract question and nothing more. Results are committed as `${WORKSPACE}/plans/${SLUG}/PROBE-FINDINGS.md` and cited in the DESIGN.md Research section.

A probe is NOT required for `confidence: high` assumptions verified by direct code reading during research.

**Part 2 — Invocation is the only valid probe.**

A probe must actually invoke the capability. The following are NOT probes — they are assumptions:
- "The plugin cache directory contains this tool's manifest" → the tool may have a different operation set than expected, or the binary may not be on PATH
- "This tool was available in a prior build / prior session" → availability can change between sessions
- "The harness does not block this tool name in my allowlist" → the tool may not be installed at all, or may lack the specific operation needed

If the probing agent lacks the tool or spawn capability needed to run the probe (e.g., the engineer does not have the target tool in its `tools:` allowlist, or lacks the `Agent` tool to spawn a subprobe), the probe is structurally impossible for that agent. In that case, the orchestrator MUST take over and run the probe using its own spawn capability. The engineer must NOT report a probe result derived from indirect evidence.

## Examples

**Bad — inferred probe result accepted:**

```
# Engineer in build worktree reports:
LSP probe result: CONSTRAINED
Rationale: The LSP plugin cache entry exists at .canon/capabilities/lsp.json and
the tool is not explicitly blocked at the harness level for this agent type.
Capability is available but constrained to allowlisted agents.
```

*This inference is wrong.* The engineer cannot know the actual operation set of the tool, whether the underlying binary is on PATH, or what the tool returns when called — without calling it. Accepting this report would have shipped documentation asserting a `getDiagnostics` operation that does not exist.

**Good — orchestrator takes over probe when engineer cannot run it:**

```
# Orchestrator recognizes engineer lacks Agent tool + LSP in its allowlist.
# Orchestrator spawns a dedicated probe agent with LSP in tools: allowlist.

Probe agent invokes: LSP.listFiles({ workspacePath: worktreePath })
Probe agent reports:
  - typescript-language-server: NOT FOUND on PATH (which node: /usr/local/bin/node; tsc: not found)
  - LSP tool operation set: { listFiles, getReferences, findDefinition }
    No getDiagnostics operation — the operation does not exist.

PROBE-FINDINGS.md committed. Design updated: LSP diagnostic capability is UNAVAILABLE.
```

**Bad — design frozen before probe on medium-confidence assumption:**

```yaml
# DESIGN.md ASSUMPTIONS section:
- id: A1
  claim: "roots/list is answered by the client over Streamable HTTP"
  confidence: medium
  source: "SDK docs suggest this; not verified against Claude Code 2.1.167"
```

*A `confidence: medium` assumption requires a probe before design freeze.* Proceeding directly to implementation means discovering the answer during coding or review — at significantly higher cost.

**Good — probe runs before design freeze:**

```yaml
# DESIGN.md ASSUMPTIONS section:
- id: A1
  claim: "roots/list is answered by the client over Streamable HTTP (~1.4s via SSE)"
  confidence: high
  source: "PROBE-FINDINGS.md §3 — verified against Claude Code 2.1.167 + SDK 1.29.0"
  probe_finding: "Client declares roots capability; GET SSE opens before tools/list;
                  roots/list answered ~1.4s. Symlink: /tmp → /private/tmp on macOS."
```

*Confidence upgraded to high after actual invocation. Probe also surfaced the macOS realpath finding — an obligation that could not have been discovered by reading docs.*

## Exceptions

- `confidence: high` assumptions verified by direct code reading during research do not require a probe.
- Probes for assumptions that are structurally verifiable by static analysis (e.g., "this function has this signature") are satisfied by the code reading itself — no runtime invocation needed.
- When a probe would require provisioning external infrastructure not available in the build environment (e.g., a third-party SaaS with no local equivalent), document the assumption as unverifiable and add a runtime validation instead.

## Anti-Rationalization

| Excuse | Why It's Wrong | Correct Action |
|--------|---------------|----------------|
| "The plugin cache confirms the tool exists." | Cache presence proves the manifest is installed — not that the binary is on PATH, not what operations the tool supports, not what it returns when called. | Spawn a probe agent with the tool in its allowlist and call it. |
| "It worked in the last build, so the assumption still holds." | Environment, PATH, and tool versions change between sessions and builds. A past result is not a current probe. | Re-probe when the assumption is load-bearing for the current design. |
| "The engineer said CONSTRAINED — I'll trust that." | CONSTRAINED is a valid probe result only when the agent actually called the tool and received a permission error. Inference-derived CONSTRAINED is indistinguishable from wrong until something breaks. | Verify the engineer's probe report includes the actual tool response, not an environment-inspection rationale. |
| "Running a probe adds a step." | The probe step costs minutes. The alternative — discovering wrong assumptions during implementation, review, or post-ship — costs hours and may ship incorrect documentation to downstream agents. | Run the probe. |

## Verification

The architect's `DESIGN.md` passes this convention when:

- [ ] All `confidence: medium` or `confidence: unknown` ASSUMPTIONS entries cite `PROBE-FINDINGS.md` as their source (or are explicitly marked as unverifiable exceptions with a runtime-validation substitute).
- [ ] `${WORKSPACE}/plans/${SLUG}/PROBE-FINDINGS.md` exists and reports at least one actual invocation result (not environment-inspection inference).
- [ ] If the probing agent lacked the required tool or spawn capability, the probe was taken over by the orchestrator and the PROBE-FINDINGS.md was written by the orchestrator's probe subagent — not by the engineer based on indirect evidence.
