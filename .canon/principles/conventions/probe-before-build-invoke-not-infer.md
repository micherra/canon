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
    - "docs/adr/*.md"
    - "reviews/REVIEW*.md"
    - "reviews/*.meta.json"
tags: []
---

When a design's ASSUMPTIONS section carries `confidence: medium` or `confidence: unknown` about external SDK behavior, protocol timing or ordering, or existing hook/script behavior, a throwaway empirical probe MUST run before design freeze. The probe must actually invoke the capability — inferring a result from environment inspection is not a probe. When the probing agent structurally cannot run the probe, the orchestrator must take over.

The same invoke-not-infer discipline governs any role asserting a mechanically-checkable property into a durable artifact — not only an architect's DESIGN.md ASSUMPTIONS. ADR authorship, security/correctness/adversarial review findings, and a fix round's revised claim are all subject to the identical obligation: a claim that can be checked by running the check must be checked, not carried forward from a prior document's prose. See Part 3 and the Fresh-Reprobe facet below.

## Rationale

Design assumptions that are not empirically verified carry hidden implementation risk. When an architect writes "the client will declare `roots` capability over HTTP" with `confidence: medium`, that claim may be correct or wrong — but only actual invocation can tell. The two failure modes this convention prevents:

**Failure mode 1 — Wrong assumption propagates into implementation.** PR #342 (HTTP Epic Phase 2) correctly ran an empirical probe before design freeze. The probe discovered that macOS resolves `/tmp/...` as `/private/tmp/...` via symlink. Without the probe, the scope-key normalization obligation would have shipped silently — the same bug class later appeared at the eviction cache-key seam and required adversarial effort to catch.

**Failure mode 2 — Inference substitutes for invocation.** PR #366 required an LSP capability probe. The engineer, lacking the `Agent` tool and `LSP` in its own `tools:` allowlist, inferred the probe result: "plugin cache exists + tool not blocked at harness → CONSTRAINED." This inference was wrong in two ways simultaneously: (1) `typescript-language-server` was NOT on PATH (the real result would have been FAIL, not CONSTRAINED); (2) the `LSP` tool has no `getDiagnostics` operation — a structural absence invisible to any form of environment inspection. The orchestrator ran the actual probe and discovered both facts before incorrect usage docs shipped to three agents.

**Failure mode 3 — the defect class recurs at every assertion surface, not only design freeze.** PR #509 (ADR-0002 baseline-blindness fix) set out to fix a loop's tick-1 diff blindness. While fixing it, the exact class it exists to prevent — asserting a mechanically-checkable property instead of invoking the check — recurred **five times**, at five different roles, inside that one build's own artifacts. Only one of the five fell inside this convention's original scope (`**/plans/**/DESIGN.md` / `**/plans/**/PROBE-FINDINGS.md`):

1. **ADR authorship.** `docs/adr/0045-session-start-staleness-auto-refresh-mechanism.md` line 100 asserted `loop-schema.ts` is on the ADR-0044 sensitive-path deny-list (`mcp-tool-contract` category). This was false: `grep -in "loop" confidence-scorer.ts` returns zero matches, and the file went unfloored for five days. Source: `PROBE-FINDINGS.md` Findings 1–2 of the PR #509 build. Out of the convention's original scope — an ADR is not `DESIGN.md`/`PROBE-FINDINGS.md`.
2. **Architect DESIGN.md** — inherited claim #1 verbatim into the design's Tier Consequence section. Caught when the orchestrator ran the real tool: `compute_autonomy_tier` returned `tier=supervised` but `floor_engaged: false` (score-driven, not floor-driven). This is the one instance the convention's original scope covered.
3. **Security review.** `SECURITY.md` reported "7/7 smuggling attempts blocked," implying ADR-0002's noise class was inexpressible — but all seven probed shapes attacked `append`/`from`/no-`to`. Nobody tested `{ to: "failure", fire_on_baseline: true }`, ADR-0002's own first named noise example, which `parseLoopDefinition` accepts cleanly. Out of scope — review artifacts.
4. **Orchestrator triage.** Three unchecked claims were asserted at HITL gates during the same build (a test file was claimed not to exist when it did; a SUMMARY was claimed to need committing when it was already outside the repo; a `.canon/loops/` attack path was claimed to exist when it did not). No artifact class exists to scope a file-pattern to this recurrence — triage claims live in the orchestrator's own gate messages, not a file the review pipeline reads. See Exceptions.
5. **Fix-round narrowing.** After finding #3 was fixed, the corrected claim — "two of ADR-0002's three named noise sub-classes become inexpressible" — was itself wrong: ADR-0002 names exactly **two** sub-classes, not three. See the Fresh-Reprobe facet below.

Two independent reviewer lenses (correctness, adversarial) both cited this principle by ID against `docs/adr/0056-loop-baseline-opt-in-for-state-naming-rules.md` — a file the convention's original `scope.file_patterns` does not match. Reviewer judgment was already applying this convention beyond where its frontmatter said it fired; the broadened scope below only codifies what review was already doing manually.

The pattern recurs. Every time an assertion is written down rather than measured, the cost to fix it multiplies: it may flow through design, implementation, tests, and reviewer comments before anyone discovers it was wrong.

## The Rule

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

**Part 3 — Applies beyond design freeze: any role asserting a checkable property in a durable artifact.**

The invoke-not-infer discipline is not specific to architects or to the design-freeze moment. It governs every role that writes a mechanically-checkable claim into an artifact other agents or humans will treat as ground truth:

- **ADR authorship** (`docs/adr/*.md`) — a claim that a file is on a deny-list, that a tool is registered, or that a config category applies must be checked by running the actual lookup (e.g. `grep` against the deny-list source, or invoking `compute_autonomy_tier`), not inferred from a related ADR's prose or a plausible-sounding category name.
- **Review findings** (`reviews/REVIEW*.md`, `reviews/*.meta.json`) — a claim of the "N/N cases pass," "structurally inexpressible," or "this attack surface is closed" shape is a checkable property. It must be verified by invoking the actual guard (parsing the schema, calling the tool, running the smuggling attempt) against every shape the source document names — not just the shapes that occurred to the reviewer to test.
- **Orchestrator triage claims** made at HITL gates (e.g. "this file already exists," "this artifact needs committing," "this attack path is reachable") are bound by the same discipline even though no artifact class exists to scope a `file_patterns` entry to them — see Exceptions.

A claim is in scope under Part 3 whenever it asserts a property that could be settled by running a check, grep, or tool call instead of by reading a related document or trusting a prior claim's phrasing.

## Fresh-Reprobe: A Claim Narrowed Under Review Is a New Assertion

A claim that is **narrowed** under review pressure — rather than retracted or fully re-verified — is a **fresh assertion**, not a safer version of the old one. It inherits none of the old claim's credibility and is subject to the same probe-before-assert obligation as the original. "I hedged the claim" is not equivalent to "I verified the claim."

**Why this needs its own clause.** The base rule (Parts 1–3) governs claims made before a checkpoint — design freeze, ADR authorship, initial review. This facet governs a structurally different moment: a claim made *during a fix loop, in direct response to a prior finding*. The author has just been told they were wrong once, is under time and scope pressure to close the finding, and is primed to treat "I made the claim narrower" as equivalent to "I verified the claim." These are not equivalent, and narrowing does not self-correct — it must be re-probed like any other assertion.

**Evidence — PR #509, two sequential instances on the same claim, in the same build.**

*Instance 1 — the original overclaim.* `docs/adr/0056-loop-baseline-opt-in-for-state-naming-rules.md` (lines 105–106, 185) and the accompanying `DESIGN.md` asserted "ADR-0002's noise class is now structurally inexpressible rather than convention-protected" and "a healthy baseline still surfaces nothing, structurally." The correctness reviewer probed `parseLoopDefinition` directly and found it accepts `{ to: "failure", fire_on_baseline: true }` — the exact noise shape ADR-0002 names as its first example. Verdict: BLOCKING, with a violation citing this principle against `docs/adr/0056-...md`.

*Instance 2 — the fix round's narrowing, itself unprobed.* The fix for instance 1 did not retract the safety claim; it narrowed it to "two of ADR-0002's three named noise sub-classes become inexpressible." A fresh, non-author adversarial reviewer checked the narrowed claim against ADR-0002's actual text and found it was **also wrong** — ADR-0002 names exactly **two** sub-classes in one sentence, not three, and two sibling documents in the same build state "both shapes" (2) in one place and "three named noise sub-classes" in another, self-contradicting. The reviewer's finding explicitly labeled this "the 5th recurrence of the build's own defect class: the claim was narrowed under review pressure and the new claim was asserted, not re-probed."

Instance 2 is the load-bearing evidence: it demonstrates the failure is not self-correcting even immediately after the author was told about instance 1 in the same review cycle. A narrower-sounding claim is not evidence of verification — only invocation is.

**Rule:** when a fix round responds to a finding by narrowing a claim's scope, quantity, or strength, treat the narrowed claim exactly as Parts 1–3 treat a fresh `confidence: medium`/`unknown` assumption — it requires its own probe or call-site check before it can be trusted, regardless of how much more careful it sounds than the claim it replaces.

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

**Bad — ADR asserts a deny-list membership from a related ADR's prose:**

```markdown
<!-- docs/adr/0045-session-start-staleness-auto-refresh-mechanism.md -->
- `loop-schema.ts` is sensitive-path (mcp-tool-contract) → build is supervised
  + adversarially re-reviewed.
```

*False, and never checked.* `grep -in "loop" confidence-scorer.ts` (the deny-list's own source) returns zero matches. The claim conflated two surfaces: `register-loops.ts` (the tool contract) IS on the deny-list; `loop-schema.ts` (the guardrail) is not. The false belief was laundered into a tracked ADR and then inherited verbatim by a later DESIGN.md, going unchecked for five days.

**Good — ADR claim verified by invoking the actual gate:**

```
$ grep -in "loop" mcp-server/src/features/orchestration/services/confidence-scorer.ts
(no matches)

$ echo '{ file_paths: ["loop-schema.ts"], override_tier: "autonomous" }' | compute_autonomy_tier
→ floor_engaged: false, tier: supervised (score: 37, score-driven not floor-driven)
```

*The ADR now states the checked fact*: `loop-schema.ts` is not on the sensitive-path deny-list; the build was supervised by score, not by floor. A future reader gets the true safety picture instead of an inherited false one.

**Bad — narrowed claim treated as safer without re-probing (Fresh-Reprobe violation):**

```markdown
<!-- fix-round commit message, responding to a BLOCKING finding that the original
     "structurally inexpressible" claim was false -->
Narrowed the claim: "Two of ADR-0002's three named noise sub-classes become
inexpressible." This is more conservative than the original claim, so it's safe.
```

*Still wrong, and still unprobed.* ADR-0002 names exactly two sub-classes, not three — the narrowing invented a larger denominator, which (perversely) made the barred fraction look like a majority instead of the minority it actually is. Sounding more careful is not the same as being checked.

**Good — narrowed claim re-probed against the source it claims to summarize:**

```
$ grep -A2 "Cons" docs/adr/0002-loop-first-tick-baseline-semantics.md
# ADR-0002 names exactly two sub-classes in one sentence:
# "a to: failure rule fires on an un-acted-on baseline; an append-mode rule
#  floods the entire initial state as new."

$ node -e "console.log(parseLoopDefinition({...append flood rule...}))"
→ rejected (superRefine bars it) — sub-class 1 of 2 genuinely closed

$ node -e "console.log(parseLoopDefinition({ to: 'failure', fire_on_baseline: true }))"
→ accepted — sub-class 2 of 2 (ADR-0002's own first example) remains admissible
```

*The re-probe against ADR-0002's actual text caught both the denominator error (two named sub-classes, not three) and confirmed which of the two the guard genuinely bars.*

## Exceptions

- `confidence: high` assumptions verified by direct code reading during research do not require a probe — **except** the reachability half of a compound claim (is this symbol registered/called/wired), which always requires a call-site grep or probe regardless of confidence label. See "Existence vs. reachability" above.
- Probes for assumptions that are structurally verifiable by static analysis (e.g., "this function has this signature") are satisfied by the code reading itself — no runtime invocation needed. This exception covers *shape* claims only, not reachability claims.
- When a probe would require provisioning external infrastructure not available in the build environment (e.g., a third-party SaaS with no local equivalent), document the assumption as unverifiable and add a runtime validation instead.
- **Orchestrator-triage claims have no file-pattern surface to scope to.** Part 3's orchestrator-triage recurrence (claims asserted at HITL gates, not written to a reviewable file) is bound by this convention's discipline but cannot be enforced via `scope.file_patterns` — there is no artifact for the review pipeline to match against. This is a known-uncovered surface, not a carve-out: the obligation to invoke rather than infer still applies; only the mechanical file-pattern enforcement does not reach it. A future `references/canon-orchestrator.md` process rule is the likely enforcement point, not a change to this file's frontmatter.

## Anti-Rationalization

| Excuse | Why It's Wrong | Correct Action |
|--------|---------------|----------------|
| "The plugin cache confirms the tool exists." | Cache presence proves the manifest is installed — not that the binary is on PATH, not what operations the tool supports, not what it returns when called. | Spawn a probe agent with the tool in its allowlist and call it. |
| "It worked in the last build, so the assumption still holds." | Environment, PATH, and tool versions change between sessions and builds. A past result is not a current probe. | Re-probe when the assumption is load-bearing for the current design. |
| "The engineer said CONSTRAINED — I'll trust that." | CONSTRAINED is a valid probe result only when the agent actually called the tool and received a permission error. Inference-derived CONSTRAINED is indistinguishable from wrong until something breaks. | Verify the engineer's probe report includes the actual tool response, not an environment-inspection rationale. |
| "Running a probe adds a step." | The probe step costs minutes. The alternative — discovering wrong assumptions during implementation, review, or post-ship — costs hours and may ship incorrect documentation to downstream agents. | Run the probe. |
| "I read the code and confirmed it — that's `confidence: high`." | Reading a definition site confirms existence and shape, not reachability. A symbol can exist, have the right type, and still have zero call sites. | Split the claim: keep `confidence: high` for the shape half; require a call-site grep or probe for the reachability half. |
| "This is an ADR, not a DESIGN.md — the probe convention doesn't apply here." | ADRs are durable records other builds inherit claims from without re-checking (PR #509's ADR-0045 false deny-list claim was laundered into a later DESIGN.md verbatim). A checkable claim in an ADR is exactly as much in scope as one in a DESIGN.md ASSUMPTIONS entry. | Invoke the check before committing the ADR claim, per Part 3. |
| "I narrowed the claim after the finding, so it's safer now." | Narrowing is not verification. PR #509's fix round narrowed "structurally inexpressible" to "two of three sub-classes" and the narrowed claim was itself wrong — the failure mode is not self-correcting, even one review cycle after the author was told about the first instance. | Re-probe the narrowed claim against its cited source with the same rigor as a fresh assumption. See Fresh-Reprobe above. |
| "The review already said N/N cases pass — that's enough." | An "N/N pass" claim is only as good as the N cases someone thought to test. PR #509's security review reported 7/7 smuggling attempts blocked while never testing the noise class's own first named example. | Check the claim's N against the full enumerated set in the source document (e.g. every noise sub-class an ADR names), not just the set the reviewer happened to test. |

## Verification

The architect's `DESIGN.md` passes this convention when:

- [ ] All `confidence: medium` or `confidence: unknown` ASSUMPTIONS entries cite `PROBE-FINDINGS.md` as their source (or are explicitly marked as unverifiable exceptions with a runtime-validation substitute).
- [ ] `${WORKSPACE}/plans/${SLUG}/PROBE-FINDINGS.md` exists and reports at least one actual invocation result (not environment-inspection inference).
- [ ] If the probing agent lacked the required tool or spawn capability, the probe was taken over by the orchestrator and the PROBE-FINDINGS.md was written by the orchestrator's probe subagent — not by the engineer based on indirect evidence.
- [ ] Any ASSUMPTIONS entry making a reachability claim (registered / called / wired into the live path) cites a call-site grep result or a probe finding as its source — a definition-site grep alone does not satisfy this, even at `confidence: high`. Compound shape+reachability claims are split so each half cites its own verification.

An ADR (`docs/adr/*.md`) or a review artifact (`reviews/REVIEW*.md`, `reviews/*.meta.json`) passes this convention when:

- [ ] Every checkable claim (deny-list membership, tool registration, "N/N cases pass," "structurally inexpressible") cites the actual check invoked (grep against the real source, tool call output, or a probe finding) — not a related document's prose or an inherited claim.
- [ ] A claim narrowed in response to a prior finding cites its own fresh verification against the source it claims to summarize, per the Fresh-Reprobe facet — it does not inherit credibility from being "more careful" than the claim it replaces.
- [ ] An "N/N cases pass" or "class X is inexpressible" claim was checked against every shape the cited source document names, not only the shapes the author or reviewer thought to test.
