---
id: probe-before-build-invoke-not-infer
title: Probe External Contracts Before Design Freeze — Invoke, Don't Infer
severity: convention
portable: false
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

A probe is NOT required for `confidence: high` assumptions verified by direct code reading during research — except the reachability half of a compound claim, which always requires a call-site check regardless of confidence label. See "Existence vs. reachability" in Part 2 below.

**Part 2 — Invocation is the only valid probe.**

A probe must actually invoke the capability. The following are NOT probes — they are assumptions:
- "The plugin cache directory contains this tool's manifest" → the tool may have a different operation set than expected, or the binary may not be on PATH
- "This tool was available in a prior build / prior session" → availability can change between sessions
- "The harness does not block this tool name in my allowlist" → the tool may not be installed at all, or may lack the specific operation needed

If the probing agent lacks the tool or spawn capability needed to run the probe (e.g., the engineer does not have the target tool in its `tools:` allowlist, or lacks the `Agent` tool to spawn a subprobe), the probe is structurally impossible for that agent. In that case, the orchestrator MUST take over and run the probe using its own spawn capability. The engineer must NOT report a probe result derived from indirect evidence.

**Existence vs. reachability.** A "verified by direct code reading" claim about **reachability** — is this symbol registered, called, or wired into the live execution path — requires reading the **call site**, not just the **definition site**. Confirming that a file exists, an export is present, or two type shapes match is a definition-site check; it does not satisfy a reachability claim, even at `confidence: high`. When an ASSUMPTIONS entry bundles a shape/contract claim together with a reachability claim, split them: the shape claim may keep `confidence: high` from definition-site reading, but the reachability claim requires either a call-site grep (e.g. `grep -rn 'registerXTool(' src/app/`) cited as its own verification, or a probe. This mirrors the reviewer's Stage 2 "Agent→Tool Reachability" sub-axis (`agents/reviewer.md`) — both enforcement points must apply the same existence-vs-reachability discipline, or the defect recurs one build phase earlier (architect ASSUMPTIONS, or the PRD that precedes it), where a false "no code change needed" conclusion can shape an entire runbook before a downstream reviewer gate catches it.

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

**Bad — compound claim inherits high confidence from only the verified half:**

```yaml
# DESIGN.md ASSUMPTIONS section:
- id: A1
  claim: "evaluate-step.ts exports EvaluateStepOutput matching agents/evaluator.md's
          Input Contract; tool is registered and reachable from the orchestrator.
          No code change needed."
  confidence: high
  source: "Direct code reading: grepped register-evaluate-step.ts, confirmed it
           defines registerEvaluateStepTool."
```

*Wrong.* The grep chain confirmed `registerEvaluateStepTool` is *defined* — a definition-site check — but never confirmed it is *called* anywhere. `registerEvaluateStepTool` had zero call sites; a prior PR had silently removed the registration call the same day this one added it. The shape half of the claim was correctly high-confidence; the reachability half was never checked, but the whole compound ASSUMPTION inherited "high confidence, no probe needed."

**Good — compound claim split into its shape and reachability halves:**

```yaml
# DESIGN.md ASSUMPTIONS section:
- id: A1a
  claim: "evaluate-step.ts exports EvaluateStepOutput matching agents/evaluator.md's
          Input Contract."
  confidence: high
  source: "Direct code reading — definition-site shape comparison."
- id: A1b
  claim: "registerEvaluateStepTool is called from register-orchestration.ts (reachable)."
  confidence: high
  source: "grep -rn 'registerEvaluateStepTool(' mcp-server/src/app/ — 1 call site
           found at register-orchestration.ts:27."
```

*Each half now cites its own verification.* A1b's call-site grep would have caught the zero-call-site defect before design freeze, instead of one full implement-review cycle later.

## Exceptions

- `confidence: high` assumptions verified by direct code reading during research do not require a probe — **except** the reachability half of a compound claim (is this symbol registered/called/wired), which always requires a call-site grep or probe regardless of confidence label. See "Existence vs. reachability" above.
- Probes for assumptions that are structurally verifiable by static analysis (e.g., "this function has this signature") are satisfied by the code reading itself — no runtime invocation needed. This exception covers *shape* claims only, not reachability claims.
- When a probe would require provisioning external infrastructure not available in the build environment (e.g., a third-party SaaS with no local equivalent), document the assumption as unverifiable and add a runtime validation instead.

## Anti-Rationalization

| Excuse | Why It's Wrong | Correct Action |
|--------|---------------|----------------|
| "The plugin cache confirms the tool exists." | Cache presence proves the manifest is installed — not that the binary is on PATH, not what operations the tool supports, not what it returns when called. | Spawn a probe agent with the tool in its allowlist and call it. |
| "It worked in the last build, so the assumption still holds." | Environment, PATH, and tool versions change between sessions and builds. A past result is not a current probe. | Re-probe when the assumption is load-bearing for the current design. |
| "The engineer said CONSTRAINED — I'll trust that." | CONSTRAINED is a valid probe result only when the agent actually called the tool and received a permission error. Inference-derived CONSTRAINED is indistinguishable from wrong until something breaks. | Verify the engineer's probe report includes the actual tool response, not an environment-inspection rationale. |
| "Running a probe adds a step." | The probe step costs minutes. The alternative — discovering wrong assumptions during implementation, review, or post-ship — costs hours and may ship incorrect documentation to downstream agents. | Run the probe. |
| "I read the code and confirmed it — that's `confidence: high`." | Reading a definition site confirms existence and shape, not reachability. A symbol can exist, have the right type, and still have zero call sites. | Split the claim: keep `confidence: high` for the shape half; require a call-site grep or probe for the reachability half. |

## Verification

The architect's `DESIGN.md` passes this convention when:

- [ ] All `confidence: medium` or `confidence: unknown` ASSUMPTIONS entries cite `PROBE-FINDINGS.md` as their source (or are explicitly marked as unverifiable exceptions with a runtime-validation substitute).
- [ ] `${WORKSPACE}/plans/${SLUG}/PROBE-FINDINGS.md` exists and reports at least one actual invocation result (not environment-inspection inference).
- [ ] If the probing agent lacked the required tool or spawn capability, the probe was taken over by the orchestrator and the PROBE-FINDINGS.md was written by the orchestrator's probe subagent — not by the engineer based on indirect evidence.
- [ ] Any ASSUMPTIONS entry making a reachability claim (registered / called / wired into the live path) cites a call-site grep result or a probe finding as its source — a definition-site grep alone does not satisfy this, even at `confidence: high`. Compound shape+reachability claims are split so each half cites its own verification.
