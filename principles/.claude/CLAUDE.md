# Canon Principles — Project Guidelines

<!-- Managed by Canon. Manual edits are preserved. -->

## Purpose
Engineering principles encoded as markdown files with frontmatter metadata. Principles guide code generation, are checked during review, and refined through the learning loop.

## Architecture
<!-- last-updated: 2026-03-22 -->

Principles are organized by severity level:

```
principles/
├── rules/              # Non-negotiable; enforced pre-commit
├── strong-opinions/    # Strongly recommended; flagged during review
└── conventions/        # Best practices; suggested improvements
```

Each principle file has YAML frontmatter: `id`, `severity`, `title`, `tags`, `layers`, `file_patterns`, `description`. The body contains rationale, examples, and counter-examples.

**Severity levels:**

| Level | Directory | Enforcement |
|-------|-----------|-------------|
| `rule` | `rules/` | Hard block — must be fixed before commit |
| `strong-opinion` | `strong-opinions/` | Flagged in review — requires justification to deviate |
| `convention` | `conventions/` | Suggested — deviations noted but not blocking |

## Artifact Inventory
<!-- canon:inventory:start class=principles -->
| artifact | summary |
|---|---|
| accumulator-test-coverage.md | Accumulator Functions Require Multi-Event Test Cases |
| aggregates-reference-by-id.md | Aggregates Reference Other Aggregates by ID Only |
| architectural-fitness-functions.md | Enforce Architecture with Automated Tests |
| backward-compatible-schema-changes.md | Schema Changes Must Be Backward Compatible |
| bounded-context-boundaries.md | Enforce Bounded Context Boundaries in Code |
| colocate-component-assets.md | Colocate Component Assets |
| command-query-separation.md | Commands and Queries Don't Mix |
| compose-from-small-to-large.md | Compose UI from Small to Large |
| compute-effect-naming-convention.md | Pure Functions Use compute* Prefix; Effect Functions Use Effect-Indicating Prefix |
| compute-effect-separation.md | Extract Pure Computation from Effect-Bearing Functions |
| consistent-abstraction-levels.md | Each Function Operates at One Abstraction Level |
| dao-parameter-injection-in-diagnostics-services.md | DAO Parameter Injection in Diagnostics Services |
| decompose-by-domain-not-layer.md | Decompose by Business Domain, Not Technical Layer |
| deep-modules.md | Deep Modules, Simple Interfaces |
| define-errors-out-of-existence.md | Define Errors Out of Existence |
| deploy-frontend-modules-independently.md | Deploy Frontend Modules Independently |
| design-for-self-healing.md | Design for Automatic Recovery |
| design-tokens-as-style-contract.md | Design Tokens Are the Style Contract |
| doc-trim-fact-preservation.md | Doc-Trim Builds Require a Reviewer Fact-Preservation Audit |
| enrichment-pipeline-convention.md | Enrichment Pipeline Follows DAO + Service + Fail-Open Wrapper Shape |
| errors-are-values.md | Errors Are Values, Not Surprises |
| explicit-transaction-boundaries.md | Define Transaction Boundaries Explicitly |
| externalize-configuration.md | Externalize Environment-Specific Configuration |
| fail-closed-by-default.md | Fail Closed by Default |
| fail-open-audit-event-emission.md | Detection/Compute Tools Emit Fail-Open Audit Events from Inside the Tool |
| functions-do-one-thing.md | Functions Do One Thing |
| handle-partial-failure.md | Handle Partial Failure in Distributed Calls |
| hooks-fail-closed.md | Safety Hooks Must Fail Closed |
| hooks-observable-failures.md | Hook Failures Must Be Observable or Explicitly Justified |
| idempotent-operations.md | Retryable Operations Must Be Idempotent |
| immutable-infrastructure.md | Infrastructure Components Are Immutable After Deployment |
| information-hiding.md | Each Module Hides a Design Decision |
| infrastructure-tested-like-code.md | Validate Infrastructure Definitions Before Deployment |
| install-faithful-dev-repo.md | Plugin-Shipped Runtime Files Must Be Faithful to an Installed Layout |
| isolate-frontend-runtime-state.md | Isolate Runtime State Between Frontend Modules |
| law-of-demeter.md | Talk to Neighbors, Not Strangers |
| lazy-freshness-gate.md | Lazy Freshness Gate for Commit-Granularity Caches |
| least-privilege-access.md | Grant Only the Minimum Access Required |
| leave-touched-files-better.md | Leave Touched Files Better Than You Found Them |
| line-limit-split-into-siblings.md | Extract Cohesive Siblings When a File Crosses the Line Limit |
| measure-before-optimizing.md | Measure Before Optimizing |
| minimize-attack-surface.md | Minimize the Attack Surface |
| minimize-client-side-state.md | Minimize Client-Side State |
| no-hidden-side-effects.md | No Hidden Side Effects |
| no-llm-calls-in-mcp-tools.md | MCP Tools Must Not Make LLM API Calls |
| normalize-first-denormalize-intentionally.md | Normalize First, Denormalize With Justification |
| observable-best-effort.md | Best-Effort Operations Must Be Observable |
| one-behavior-per-test.md | One Behavior Per Test |
| patterns-need-justification.md | Every Pattern Must Justify Its Complexity |
| per-connection-scope-threading.md | MCP Handler Registration Boundaries Thread Project Scope via resolveScope |
| prefer-async-between-services.md | Prefer Asynchronous Communication Between Services |
| prefer-browser-native-integration.md | Prefer Browser-Native APIs for Cross-Module Communication |
| prefer-composition-over-inheritance.md | Prefer Composition Over Inheritance |
| prefer-constructor-injection.md | Prefer Constructor Injection |
| prefer-immutable-data.md | Prefer Immutable Data by Default |
| props-are-the-component-contract.md | Props Are the Component Contract |
| pure-io-service-split.md | Split Services Into a Pure Entry Point and an I/O Companion |
| read-only-tool-reuse-over-reimplementation.md | New MCP Tools Must Reuse Existing Internal Helpers Rather Than Reimplementing Their Logic |
| refactoring-integrity.md | Refactoring Must Be Substantive, Not Cosmetic |
| resilient-frontend-composition.md | A Failing Module Must Not Break the Page |
| secrets-never-in-code.md | Secrets Must Never Appear in Source Code |
| services-own-their-data.md | Each Service Owns Its Data Store Exclusively |
| shared-renderer-helper-placement.md | Shared Renderer Helpers — Build-Time Logic in DESIGN-SYSTEM.md, Runtime Scripts in Snippet Files |
| simplicity-first.md | The Simplest Thing That Could Work |
| single-source-of-component-styles.md | One Component, One Style Source |
| snippet-design-system-co-update.md | New Snippet Files Require Corresponding DESIGN-SYSTEM.md Section |
| snippet-docblock-metadata.md | HTML Snippet Files Require Machine-Readable Docblock |
| source-shared-hook-helpers.md | Hooks Must Source Shared Helper Library for JSON Extraction |
| spawn-prompt-template-structure.md | Spawn-Prompt Templates Use Variables-Prompt Structure |
| structured-logging-with-levels.md | Log Structured Events at the Right Level |
| test-data-belongs-in-the-test.md | Test Data Belongs in the Test |
| tests-are-deterministic.md | Tests Must Be Deterministic |
| tests-are-independent.md | Tests Must Be Independent |
| ubiquitous-language-in-code.md | Code Uses the Domain's Ubiquitous Language |
| unidirectional-data-flow.md | Data Flows Down, Events Flow Up |
| validate-at-trust-boundaries.md | Validate Data at Every Trust Boundary |
| verification-grep-minimum-scope.md | Verification Greps Use Minimum-Sufficient Scope |
| version-public-apis.md | Version Public-Facing APIs from Day One |
| wrap-external-exceptions.md | Wrap External Exceptions at the Boundary |
<!-- canon:inventory:end -->

## Contracts
<!-- last-updated: 2026-05-02 (scope.tags matching + no-llm-calls-in-mcp-tools rule) -->

- Principles are loaded by the MCP server via `get_principles` and `review_code` tools
- `matcher.ts` in mcp-server filters principles by layer, file pattern, tags, and severity; uses OR semantics — a principle matches if its layers OR its `scope.tags` intersect the file's KG-computed tags (updated 2026-05-02)
- `parser.ts` in mcp-server extracts frontmatter metadata from principle files; `PrincipleScope` type now includes optional `tags?: string[]` field (updated 2026-05-02)
- The `learner` agent proposes new principles; the `reviewer` checks against them
- Principles may declare `scope.tags` in frontmatter for tag-based matching; OR semantics with `layers` (added 2026-05-02)

## Conventions
<!-- last-updated: 2026-06-07 -->

- Each principle has a unique `id` used for compliance tracking
- Principles should be specific and actionable — not aspirational
- Rules (7): `secrets-never-in-code`, `least-privilege-access`, `fail-closed-by-default`, `validate-at-trust-boundaries`, `no-llm-calls-in-mcp-tools` (added 2026-05-02 — MCP tools must not make LLM API calls), `refactoring-integrity`, `hooks-fail-closed` (added 2026-05-29 — safety/guard hooks must fail closed on extraction failure or missing tooling; scoped to `hooks/**`)
- Strong opinions cover architecture, testing, error handling, data flow
- Conventions cover naming, file organization, test structure (36 total as of 2026-06-07)
- `accumulator-test-coverage` (added 2026-05-16) — accumulator functions in `mcp-server/**` require at least one test case with N>1 input and exact numeric assertion; capped accumulators require below-cap, at-cap, and above-cap cases
- `source-shared-hook-helpers` (added 2026-05-29) — hooks that parse Claude Code `tool_input` JSON must source `hooks/lib/canon-hook-lib.sh` and use `canon_extract_command`; no inlined extraction expressions; scoped to `hooks/**`
- `hooks-observable-failures` (added 2026-05-29) — bare silent swallows (`|| true`, `2>/dev/null`) in `hooks/**` must carry a justifying comment, emit `CANON WARNING:` to stderr, or exit non-zero; the `hooks/**`-scoped sibling of `observable-best-effort` at convention severity (see decision quality-coverage-01); scoped to `hooks/**`
- `verification-grep-minimum-scope` (added 2026-06-07) — grep/awk patterns in mechanical verification commands must be minimum-sufficient: tool-name greps must be `$`-anchored to prevent prefix-family false positives; awk `tools:` block extractor must use `/^[^ \t]/` terminator to prevent leaking post-`tools:` blocks

## Anti-Rationalization

| Excuse | Why It's Wrong | Correct Action |
|--------|---------------|----------------|
| "This principle is too strict for this case." | Principles prevent common failure modes specifically in edge cases and delivery pressure, where shortcuts look most attractive. | Apply the principle unless a concrete, bounded exception is documented under `## Exceptions`. |
| "We'll clean it up after this ships." | Deferred quality work usually becomes permanent debt and normalizes repeated violations. | Implement the compliant approach now, or record an explicit follow-up with owner and due date. |
| "Code review can catch this later." | Manual review is inconsistent under time pressure and cannot replace explicit constraints. | Encode compliance in code structure, tests, or linting so violations fail fast and repeatably. |
| "This is just a small change, so the rule doesn't matter." | Small changes accumulate into systemic drift when principles are waived incrementally. | Hold small changes to the same bar and verify the invariant still holds after each change. |

## Verification

- [ ] Updated files satisfy this principle's core constraint in behavior and structure.
- [ ] Any deviation is explicitly documented under `## Exceptions` with rationale and bounds.
- [ ] Tests, lints, or checks were added/updated where needed so regressions are detectable.
