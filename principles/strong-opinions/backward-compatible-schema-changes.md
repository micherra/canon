---
id: backward-compatible-schema-changes
title: Schema Changes Must Be Backward Compatible
severity: strong-opinion
portable: true
scope:
  layers:
    - data
  file_patterns:
    - "**/migrations/**"
    - "**/migrate/**"
    - "**/schema*"
    - "**/*.sql"
    - "**/prisma/**"
    - "**/drizzle/**"
tags:
  - database
  - schema-evolution
  - data-intensive
---

Schema migrations — database columns, message formats, API contracts — must be backward compatible within a single release. New columns must be optional with defaults. Existing columns must not be removed or renamed in the same deployment that introduces the replacement. Breaking changes require a multi-phase migration: add new → migrate data → update code → remove old (in a subsequent release).

## Rationale

*Grokking Relational Database Design* and *Designing Data-Intensive Applications* both emphasize that in any system with rolling deployments, old code and new code run simultaneously during a deploy window. A migration that renames a column breaks the old code instances that are still running. The database is a shared resource — the schema must be compatible with both the old and new versions of the application during the transition.

The failure mode: a deploy adds column `full_name` and drops `first_name`/`last_name` in the same migration. During the rolling deploy, old instances crash because the columns they depend on are gone. The deploy is rolled back, but the data migration already ran. Now `first_name` and `last_name` are restored but empty.

## Examples

**Bad — breaking schema change in a single release:**

```sql
-- Migration that breaks running instances
ALTER TABLE users RENAME COLUMN name TO full_name;
ALTER TABLE users DROP COLUMN legacy_role;
ALTER TABLE orders ALTER COLUMN status TYPE integer USING status::integer;
-- Old code still references "name" and "legacy_role" — instant failures
```

```prisma
// Prisma schema change that generates a breaking migration
model User {
  // Was: name String
  fullName String @map("full_name")  // Rename = drop + create
}
```

**Good — backward-compatible multi-phase migration:**

```sql
-- Phase 1 (this release): Add new column alongside old one
ALTER TABLE users ADD COLUMN full_name VARCHAR(255);
-- Backfill: populate new column from old
UPDATE users SET full_name = name WHERE full_name IS NULL;
-- Add trigger to keep both in sync during transition
CREATE TRIGGER sync_name BEFORE INSERT OR UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION sync_name_columns();

-- Phase 2 (next release, after all code uses full_name):
-- Update application code to use full_name
-- Drop old column only after confirming no code references it
-- ALTER TABLE users DROP COLUMN name;
-- DROP TRIGGER sync_name ON users;
```

```sql
-- Safe: new nullable column with default
ALTER TABLE orders ADD COLUMN priority VARCHAR(20) DEFAULT 'normal';
-- Old code ignores this column; new code can use it
```

## Exceptions

Greenfield projects before their first production deployment can make breaking changes freely — there are no existing consumers. Development databases that can be destroyed and recreated from scratch (via seed scripts) do not need phased migrations. Breaking changes to internal event schemas are acceptable if all producers and consumers deploy atomically (e.g., in a monolith).

## Related

[[normalize-first-denormalize-intentionally]] governs initial schema design — start normalized, denormalize with justification. This principle governs how those schemas evolve safely over time.

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
