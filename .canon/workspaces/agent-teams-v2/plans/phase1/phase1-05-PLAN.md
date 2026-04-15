---
task_id: "phase1-05"
wave: 2
depends_on:
  - "phase1-00"
  - "phase1-01"
  - "phase1-02"
  - "phase1-03"
  - "phase1-04"
files:
  - rules/agent-context-check.md
  - skills/canon/references/ (symlinks for 21 rules)
  - skills/canon/references/ (6 migrated domain primers)
  - skills/canon/references/ (6 new domain skills)
principles:
  - simplicity-first
  - information-hiding
domains: []
---

## Task: Register rules as skills, migrate domain primers, create domain skills

### Action

Three deliverables:

#### A. Register rules as skills

Create symlinks from `rules/*.md` to `skills/canon/references/` so agent definitions can reference them via `skills:` frontmatter.

```bash
cd skills/canon/references/
for rule in ../../../rules/agent-*.md; do
  name=$(basename "$rule")
  ln -sf "$rule" "$name"
done
```

Verify: every `agent-*.md` rule file has a corresponding symlink in `skills/canon/references/`.

#### B. Create agent-context-check rule

Write `rules/agent-context-check.md`:

```markdown
---
id: agent-context-check
severity: rule
tags: [agent-behavior, context, self-serve]
scope:
  agents: all
---

# Verify Context Before Starting Work

Before starting work, check your spawn prompt for context:

1. **Principles**: If your spawn prompt does not include a `## Principles` section, call `get_principles` with your target file path and task description.

2. **File context**: If you need dependency or graph information not in your prompt, call `get_file_context` or `graph_query` directly.

3. **Domain skills**: If your spawn prompt includes a `Relevant domain skills:` list, Read each named skill file from `skills/canon/references/` before starting work.

4. **Template**: If your spawn prompt names a template (e.g., `Use template: implementation-log`), Read it from `templates/` before producing output.

Do not block or report an error if context is missing — self-serve it via MCP tools and Read.
```

Symlink this into `skills/canon/references/` as well.

#### C. Migrate domain primers

Move existing primers from `domain-primers/` to `skills/canon/references/`:

```bash
cp domain-primers/backend-api.md skills/canon/references/
cp domain-primers/backend-data.md skills/canon/references/
cp domain-primers/frontend.md skills/canon/references/
cp domain-primers/testing.md skills/canon/references/
cp domain-primers/infrastructure.md skills/canon/references/
cp domain-primers/deprecation.md skills/canon/references/
```

#### D. Create 6 new domain skills

Write ~30-40 lines each in `skills/canon/references/`, following the existing primer format (Mental Models, Decision Frameworks, Failure Modes, Guardrails):

1. `authentication-security.md` — auth patterns, credential handling, session management, common auth vulnerabilities
2. `migration-strategy.md` — zero-downtime patterns, feature flags, data backfill, rollback procedures
3. `observability.md` — logging conventions, metrics, tracing, structured logging, alerting philosophy
4. `error-handling.md` — error taxonomy, propagation patterns, retry strategies, circuit breakers
5. `performance.md` — profiling methodology, bottleneck patterns, caching, "measure before optimizing"
6. `devops-ci.md` — CI/CD patterns, build optimization, environment parity, container best practices

### Canon principles to apply

- **simplicity-first**: Symlinks, not copies. Rules stay in `rules/` as source of truth.
- **information-hiding**: Domain skills encapsulate domain expertise. Agents don't need to know where the content came from.

### Tests to write

No code tests. Verify symlinks resolve and files parse.

### Verify

1. All 21 `agent-*.md` rules have symlinks in `skills/canon/references/`
2. `agent-context-check.md` exists in both `rules/` and `skills/canon/references/`
3. 6 domain primers exist in `skills/canon/references/` (migrated from `domain-primers/`)
4. 6 new domain skill files exist in `skills/canon/references/`
5. All files parse as valid markdown
6. `npm run build` and `npm test` pass unchanged

### Done when

- 21 rule symlinks + 1 new rule + 6 migrated primers + 6 new domain skills = 34 files in `skills/canon/references/` (plus existing 11 references)
- agent-context-check covers principles, file context, domain skills, and templates
- All symlinks resolve correctly
