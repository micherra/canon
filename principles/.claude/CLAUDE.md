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
| aggregates-reference-by-id.md | Aggregates Reference Other Aggregates by ID Only |
| architectural-fitness-functions.md | Enforce Architecture with Automated Tests |
| backward-compatible-schema-changes.md | Schema Changes Must Be Backward Compatible |
| bounded-context-boundaries.md | Enforce Bounded Context Boundaries in Code |
| colocate-component-assets.md | Colocate Component Assets |
| command-query-separation.md | Commands and Queries Don't Mix |
| compose-from-small-to-large.md | Compose UI from Small to Large |
| consistent-abstraction-levels.md | Each Function Operates at One Abstraction Level |
| decompose-by-domain-not-layer.md | Decompose by Business Domain, Not Technical Layer |
| deep-modules.md | Deep Modules, Simple Interfaces |
| define-errors-out-of-existence.md | Define Errors Out of Existence |
| deploy-frontend-modules-independently.md | Deploy Frontend Modules Independently |
| design-for-self-healing.md | Design for Automatic Recovery |
| design-tokens-as-style-contract.md | Design Tokens Are the Style Contract |
| errors-are-values.md | Errors Are Values, Not Surprises |
| explicit-transaction-boundaries.md | Define Transaction Boundaries Explicitly |
| externalize-configuration.md | Externalize Environment-Specific Configuration |
| fail-closed-by-default.md | Fail Closed by Default |
| fail-closed-scan-scope.md | A Fail-Closed Scan Must Be Scoped to Its Threat Model |
| functions-do-one-thing.md | Functions Do One Thing |
| grey-box-module.md | Grey-Box Modules — Human Owns the Interface, AI Fills the Body |
| handle-partial-failure.md | Handle Partial Failure in Distributed Calls |
| harness-tool-invocation-check.md | A Harness Built-In Capability Grant Requires Runtime Invocation Verification |
| hooks-fail-closed.md | Safety Hooks Must Fail Closed |
| idempotent-operations.md | Retryable Operations Must Be Idempotent |
| immutable-infrastructure.md | Infrastructure Components Are Immutable After Deployment |
| information-hiding.md | Each Module Hides a Design Decision |
| infrastructure-tested-like-code.md | Validate Infrastructure Definitions Before Deployment |
| isolate-frontend-runtime-state.md | Isolate Runtime State Between Frontend Modules |
| law-of-demeter.md | Talk to Neighbors, Not Strangers |
| least-privilege-access.md | Grant Only the Minimum Access Required |
| leave-touched-files-better.md | Leave Touched Files Better Than You Found Them |
| measure-before-optimizing.md | Measure Before Optimizing |
| minimize-attack-surface.md | Minimize the Attack Surface |
| minimize-client-side-state.md | Minimize Client-Side State |
| no-hidden-side-effects.md | No Hidden Side Effects |
| normalize-first-denormalize-intentionally.md | Normalize First, Denormalize With Justification |
| observable-best-effort.md | Best-Effort Operations Must Be Observable |
| one-behavior-per-test.md | One Behavior Per Test |
| patterns-need-justification.md | Every Pattern Must Justify Its Complexity |
| per-folder-public-interface.md | One Public Interface Per Module Folder |
| prefer-async-between-services.md | Prefer Asynchronous Communication Between Services |
| prefer-browser-native-integration.md | Prefer Browser-Native APIs for Cross-Module Communication |
| prefer-composition-over-inheritance.md | Prefer Composition Over Inheritance |
| prefer-constructor-injection.md | Prefer Constructor Injection |
| prefer-immutable-data.md | Prefer Immutable Data by Default |
| props-are-the-component-contract.md | Props Are the Component Contract |
| refactoring-integrity.md | Refactoring Must Be Substantive, Not Cosmetic |
| resilient-frontend-composition.md | A Failing Module Must Not Break the Page |
| secrets-never-in-code.md | Secrets Must Never Appear in Source Code |
| services-own-their-data.md | Each Service Owns Its Data Store Exclusively |
| simplicity-first.md | The Simplest Thing That Could Work |
| single-source-of-component-styles.md | One Component, One Style Source |
| structured-logging-with-levels.md | Log Structured Events at the Right Level |
| test-data-belongs-in-the-test.md | Test Data Belongs in the Test |
| tests-are-deterministic.md | Tests Must Be Deterministic |
| tests-are-independent.md | Tests Must Be Independent |
| ubiquitous-language-in-code.md | Code Uses the Domain's Ubiquitous Language |
| unidirectional-data-flow.md | Data Flows Down, Events Flow Up |
| validate-at-trust-boundaries.md | Validate Data at Every Trust Boundary |
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
<!-- last-updated: 2026-06-12 -->

- Each principle has a unique `id` used for compliance tracking
- Principles should be specific and actionable — not aspirational
- Rules (6): `secrets-never-in-code`, `least-privilege-access`, `fail-closed-by-default`, `validate-at-trust-boundaries`, `refactoring-integrity`, `hooks-fail-closed` (added 2026-05-29 — safety/guard hooks must fail closed on extraction failure or missing tooling; scoped to `hooks/**`). Note: `no-llm-calls-in-mcp-tools` relocated to `.canon/principles/rules/` (Canon-internal, portable: false).
- Strong opinions cover architecture, testing, error handling, data flow
- Conventions cover naming, file organization, test structure (20 total in `principles/conventions/`; 24 Canon-internal conventions in `.canon/principles/conventions/`, portable: false)
- `accumulator-test-coverage` (added 2026-05-16) — accumulator functions in `mcp-server/**` require at least one test case with N>1 input and exact numeric assertion; capped accumulators require below-cap, at-cap, and above-cap cases
- `source-shared-hook-helpers` (added 2026-05-29) — hooks that parse Claude Code `tool_input` JSON must source `hooks/lib/canon-hook-lib.sh` and use `canon_extract_command`; no inlined extraction expressions; scoped to `hooks/**`
- `hooks-observable-failures` (added 2026-05-29) — bare silent swallows (`|| true`, `2>/dev/null`) in `hooks/**` must carry a justifying comment, emit `CANON WARNING:` to stderr, or exit non-zero; the `hooks/**`-scoped sibling of `observable-best-effort` at convention severity (see decision quality-coverage-01); scoped to `hooks/**`
- `verification-grep-minimum-scope` (added 2026-06-07) — grep/awk patterns in mechanical verification commands must be minimum-sufficient: tool-name greps must be `$`-anchored to prevent prefix-family false positives; awk `tools:` block extractor must use `/^[^ \t]/` terminator to prevent leaking post-`tools:` blocks
- `probe-before-build-invoke-not-infer` (added 2026-06-10) — **Canon-internal** (relocated to `.canon/principles/conventions/`, portable: false); when a design ASSUMPTIONS entry carries `confidence: medium` or `confidence: unknown` about external SDK behavior, protocol timing, or hook/script behavior, an empirical probe must run before design freeze
- `mechanism-ships-first-instance` (added 2026-06-09) — **Canon-internal** (relocated to `.canon/principles/conventions/`, portable: false); a build that introduces a new artifact class, registry, tracked template system, or workflow gate MUST ship at least one real, minimal, tracked instance in the same PR
- `scanner-avoids-its-own-pattern` (added 2026-06-09) — **Canon-internal** (relocated to `.canon/principles/conventions/`, portable: false); a hook, script, grep, or verification step designed to detect pattern S must not contain S verbatim in any intercepted position
- `disk-is-source-of-truth-on-resume` (added 2026-06-11) — **Canon-internal** (relocated to `.canon/principles/conventions/`, portable: false); scoped to `agents/**`, `rules/**`, `principles/**`, `references/**`, `CLAUDE.md`

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
