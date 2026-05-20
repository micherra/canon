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

## Contracts
<!-- last-updated: 2026-05-02 (scope.tags matching + no-llm-calls-in-mcp-tools rule) -->

- Principles are loaded by the MCP server via `get_principles` and `review_code` tools
- `matcher.ts` in mcp-server filters principles by layer, file pattern, tags, and severity; uses OR semantics — a principle matches if its layers OR its `scope.tags` intersect the file's KG-computed tags (updated 2026-05-02)
- `parser.ts` in mcp-server extracts frontmatter metadata from principle files; `PrincipleScope` type now includes optional `tags?: string[]` field (updated 2026-05-02)
- The `learner` agent proposes new principles; the `reviewer` checks against them
- Principles may declare `scope.tags` in frontmatter for tag-based matching; OR semantics with `layers` (added 2026-05-02)

## Conventions
<!-- last-updated: 2026-05-16 -->

- Each principle has a unique `id` used for compliance tracking
- Principles should be specific and actionable — not aspirational
- Rules (6): `secrets-never-in-code`, `least-privilege-access`, `fail-closed-by-default`, `validate-at-trust-boundaries`, `no-llm-calls-in-mcp-tools` (added 2026-05-02 — MCP tools must not make LLM API calls), `refactoring-integrity`
- Strong opinions cover architecture, testing, error handling, data flow
- Conventions cover naming, file organization, test structure
- `accumulator-test-coverage` (added 2026-05-16) — accumulator functions in `mcp-server/**` require at least one test case with N>1 input and exact numeric assertion; capped accumulators require below-cap, at-cap, and above-cap cases

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
