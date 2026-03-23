# Canon Principles

59 engineering principles organized by severity. The foundation of Canon's enforcement and learning system — they drive code generation guidance, review compliance checking, and pattern drift tracking across the entire pipeline.

---

## Severity model

Principles are divided into three tiers stored in separate subdirectories:

| Tier | Directory | Count | Enforcement |
|------|-----------|-------|-------------|
| `rule` | `rules/` | 4 | Hard constraint — blocks commits via pre-commit hook |
| `strong-opinion` | `strong-opinions/` | 36 | Default path — flagged during review, requires justification to deviate |
| `convention` | `conventions/` | 19 | Stylistic preference — deviations noted for drift tracking, never blocking |

### rules/ (4)

Non-negotiable security and safety constraints enforced at commit time. A rule violation in reviewed code produces a `BLOCKED` status — the implementor must fix before committing.

- `secrets-never-in-code` — API keys, passwords, tokens, and private keys must never appear in source files
- `least-privilege-access` — Components and services request only the permissions they actually need
- `fail-closed-by-default` — On error or ambiguity, deny access and fail safe rather than permitting
- `validate-at-trust-boundaries` — All external input is validated at the point it crosses a trust boundary

### strong-opinions/ (36)

The architectural backbone of well-built systems. Cover architecture, testing, error handling, and data flow. Agents honor these by default; any deviation requires a `JUSTIFIED_DEVIATION` declaration logged via the `report` MCP tool.

Examples: `errors-are-values`, `thin-handlers`, `tests-are-deterministic`, `information-hiding`, `simplicity-first`, `no-hidden-side-effects`, `idempotent-operations`, `wrap-external-exceptions`.

### conventions/ (19)

Stylistic preferences that make codebases consistent and readable. Never block work, but deviations accumulate in drift tracking so the learner agent can spot trends.

Examples: `naming-reveals-intent`, `arrange-act-assert`, `one-behavior-per-test`, `structured-logging-with-levels`, `ubiquitous-language-in-code`.

---

## Principle format

Each principle is a Markdown file with YAML frontmatter followed by a human-readable body.

### YAML frontmatter reference

```yaml
---
id: my-principle-id           # required — unique kebab-case identifier used for compliance tracking
title: Human-Readable Title   # required — short descriptive title
severity: strong-opinion      # required — one of: rule, strong-opinion, convention
scope:
  layers:                     # optional — which architectural layers this applies to
    - api                     #   api | ui | domain | data | infra | shared
    - domain
  file_patterns:              # optional — glob patterns for targeted matching
    - "**/*.test.ts"
    - "src/routes/**"
tags:                         # optional — freeform labels for filtering and grouping
  - error-handling
  - testing
archived: true                # optional — set to true to disable without deleting the file
---
```

**Field notes:**

- `id` must be globally unique across all principles (project-local and built-in). The `canon:doctor` command validates uniqueness.
- `scope.layers` is a list, not a single value. An empty list (`[]`) means the principle applies to all layers.
- `scope.file_patterns` uses glob syntax: `*` matches within a path segment, `**` matches across segments.
- `archived: true` removes the principle from all matching results without deleting the file. Useful for deprecating a principle while preserving its history.

### Body structure

The body follows the frontmatter and should contain:

```markdown
One-sentence summary of the constraint.

## Rationale

Why this principle exists. Reference to external sources (books, research, incidents) is encouraged.

## Examples

**Bad — anti-pattern:**
```code
...
```

**Good — correct approach:**
```code
...
```

## Exceptions

When this principle legitimately does not apply. Be specific — vague exceptions undermine the principle.
```

---

## How matching works

The `matchPrinciples` function in `mcp-server/src/matcher.ts` filters and ranks principles for a given context. Understanding this algorithm helps you write principles that match exactly the right files.

### Layer inference

When a `file_path` is provided without explicit `layers`, the matcher infers the layer from the file path by scanning for known directory names:

| Layer | Default trigger directories |
|-------|----------------------------|
| `api` | `api`, `routes`, `controllers` |
| `ui` | `app`, `components`, `pages`, `views` |
| `domain` | `services`, `domain`, `models` |
| `data` | `db`, `data`, `repositories`, `prisma` |
| `infra` | `infra`, `deploy`, `terraform`, `docker` |
| `shared` | `utils`, `lib`, `shared`, `types` |

**Example:** `src/routes/orders.ts` infers layer `api`. `src/components/Button.tsx` infers layer `ui`.

Layer inference is configurable per project via `.canon/config.json`:

```json
{
  "layers": {
    "api": ["api", "routes", "handlers"],
    "ui": ["components", "screens", "widgets"],
    "domain": ["services", "use-cases", "domain"]
  }
}
```

Project config overrides the built-in defaults entirely for any layer listed.

### Matching algorithm

Given a set of filters (file path, layers, tags, severity threshold), the matcher:

1. **Excludes archived principles** unless `include_archived` is explicitly set.
2. **Applies severity filter** — if `severity_filter` is `strong-opinion`, only `rule` and `strong-opinion` principles pass (uses severity rank ordering: rule=1, strong-opinion=2, convention=3).
3. **Applies layer filter** — if both the filter specifies layers AND the principle has `scope.layers`, at least one layer must overlap. Principles with empty `scope.layers` match all layers.
4. **Applies file pattern filter** — if the principle has `scope.file_patterns`, the file path must match at least one pattern. Principles with no file patterns match all files.
5. **Applies tag filter** — if tags are specified in the filter, the principle must have at least one matching tag.
6. **Sorts results** by severity rank (rules first), then by specificity (more `file_patterns` ranks higher as a tie-breaker).

### Result cap

Results are capped at `max_principles_per_review` (default: 10). Configure in `.canon/config.json`:

```json
{
  "review": {
    "max_principles_per_review": 15
  }
}
```

Rules always sort first, so the cap never silently drops a rule in favor of conventions.

### Mtime-based cache

The matcher maintains an in-memory cache of all loaded principles. The cache key is a concatenation of every principle file's modification time (`mtime`). When any file is added, removed, or modified, the mtime key changes and the cache is invalidated on the next tool call. This avoids re-reading all principle files on every request while staying current with edits.

---

## Project-local vs built-in

Principles are loaded from two locations and merged:

1. **Plugin built-in**: `principles/` directory in the Canon plugin itself (this directory). Shipped with Canon.
2. **Project-local**: `.canon/principles/` in the project root. Created per project for domain-specific rules.

**Merge behavior:** Both sources are loaded and combined. If a project-local principle has the same `id` as a built-in principle, the project-local version wins. This lets projects override or extend built-in principles without modifying the Canon plugin.

**Load order for precedence:**
```
project-local (.canon/principles/) → built-in (principles/)
```

To override a built-in principle, create a file in `.canon/principles/{severity}/{same-id}.md` with the same `id` in frontmatter. The built-in version is silently dropped.

---

## Agent-rules

The `agent-rules/` directory at the Canon root contains 13 principles that govern agent behavior rather than application code. They use the same frontmatter format but target how Canon's specialist agents operate.

Agent-rules are loaded by the orchestrator and injected into agent prompts via `get_principles`. They enforce Canon's process discipline — ensuring agents produce consistent, auditable, composable output.

**Examples:**

- `agent-cold-review` — The reviewer receives only the diff and matched principles, never the plan or session history. Evaluation happens in two stages: principle compliance first, then code quality.
- `agent-design-before-code` — The architect produces a plan before any implementation begins. Implementors never design on the fly.
- `agent-fresh-context` — Each agent receives only the context it needs for its task. No shared session state bleeds between agents.

Other agent-rules cover: artifact requirements (`agent-missing-artifact`, `agent-template-required`), research discipline (`agent-scoped-research`, `agent-evidence-over-intuition`), workspace scoping (`agent-workspace-scoping`), convergence limits (`agent-convergence-discipline`), and input validation (`agent-assume-hostile-input`).

---

## Writing principles

### Guided path (recommended)

Say "Create a new principle about X" in a Canon session. The `canon-writer` agent will:

1. Ask clarifying questions to sharpen scope and severity
2. Draft the principle with correct frontmatter
3. Check for ID conflicts with existing principles
4. Write the file to the appropriate directory

### Manual path

Create a `.md` file directly in `.canon/principles/{severity}/` using the format above. Choose the directory that matches the severity (`rules/`, `strong-opinions/`, or `conventions/`).

**Checklist for manual authoring:**

- `id` is unique (check existing files for conflicts)
- `severity` matches the directory
- `scope.layers` is either empty (all layers) or a valid subset of the six layer names
- Body includes rationale, at least one example, and exceptions where relevant
- The principle is specific and actionable — not aspirational

### Validation

Run `/canon:doctor` to validate all principles in both the built-in and project-local directories. Doctor checks:

- Frontmatter is valid YAML
- Required fields (`id`, `title`, `severity`) are present
- `id` values are unique across all loaded principles
- `scope.layers` contains only recognized layer names
- `severity` is one of the three valid values
- No archived principles share an `id` with an active principle

---

## MCP tools

Three tools load principles during agent execution:

| Tool | Use case | When to call |
|------|----------|--------------|
| `get_principles` | Code generation and implementation | Implementor calls before writing or modifying code to load constraints for the files it will touch |
| `review_code` | Code review | Reviewer calls to surface principles matched to a specific file alongside the file's content |
| `list_principles` | Browsing and discovery | Anyone can call to see the full principle index (metadata only, no body) — useful for exploring what principles exist |

All three tools accept `file_path`, `layers`, `tags`, and `severity_filter` parameters to narrow results. `get_principles` also accepts `summary_only: true` to return just the constraint statement without full rationale and examples — agents use this when they need constraints but not the full pedagogical content.
