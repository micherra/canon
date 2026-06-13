---
id: normalize-first-denormalize-intentionally
title: Normalize First, Denormalize With Justification
severity: convention
portable: true
scope:
  layers: []
  file_patterns:
    - "**/migrations/**"
    - "**/migrate/**"
    - "**/schema*"
    - "**/*.sql"
    - "**/prisma/**"
    - "**/drizzle/**"
tags:
  - database
  - schema-design
  - normalization
---

Database schemas should start at Third Normal Form (3NF) minimum. Every table should have a clear primary key, no repeating groups (1NF), no partial dependencies on composite keys (2NF), and no transitive dependencies between non-key columns (3NF). Denormalization is acceptable only with documented justification: specific query performance measurements, read/write ratio analysis, or identified bottlenecks. "It might be faster" is not justification.

## Rationale

*Grokking Relational Database Design* makes the case that normalization is not academic pedantry — it prevents update anomalies, insertion anomalies, and deletion anomalies. When the same data is stored in multiple places, it will inevitably get out of sync. The cost of denormalized data is paid in data integrity bugs that are subtle, hard to reproduce, and expensive to fix.

The failure mode: a developer stores `userName` alongside every order "for query performance." Users change their names, and now orders show stale names. Someone writes a migration to fix it, but new orders written during the migration still have the old name. The team adds a trigger to keep them in sync, and now every user update takes a table lock on orders.

Start normalized. Measure. If a specific query is genuinely slow, denormalize that specific path and document why, what data consistency trade-offs you're accepting, and how stale data is handled.

AI-generated schemas tend toward denormalization because LLMs optimize for the query in the prompt. Asked to "create an orders table," the LLM includes `user_name` and `user_email` inline because the prompt's example query needs that data — it doesn't consider the update anomalies this creates.

## Examples

**Bad — denormalized without justification:**

```sql
-- User data duplicated in orders table
CREATE TABLE orders (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  user_name VARCHAR(255),      -- Duplicated from users
  user_email VARCHAR(255),     -- Duplicated from users
  product_name VARCHAR(255),   -- Duplicated from products
  product_price DECIMAL(10,2), -- Duplicated from products
  quantity INT,
  total DECIMAL(10,2),
  created_at TIMESTAMP
);
-- When user changes name or product price changes, this data is stale
```

**Good — normalized with references:**

```sql
-- Normalized: each fact stored once
CREATE TABLE orders (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  created_at TIMESTAMP
);

CREATE TABLE order_items (
  id UUID PRIMARY KEY,
  order_id UUID REFERENCES orders(id),
  product_id UUID REFERENCES products(id),
  quantity INT,
  unit_price DECIMAL(10,2),  -- Captured at time of order (intentional snapshot)
  -- NOTE: unit_price is deliberately denormalized to capture price-at-purchase.
  -- Product prices change; order totals must not change retroactively.
);
```

Note: `unit_price` in `order_items` is an intentional, documented denormalization — capturing the price at time of purchase is a business requirement, not a performance optimization.

## Exceptions

Analytics and reporting schemas (star schemas, data warehouses) are intentionally denormalized for read performance — that is their documented purpose. Event stores where each event is a self-contained snapshot. Read models in CQRS architectures that are projected from normalized write models. In all cases, the denormalization is intentional, documented, and has a defined strategy for keeping data consistent.

**Related:** `backward-compatible-schema-changes` governs how to evolve schemas once they're in production — normalized or not, schema changes must be backward compatible during rolling deployments.

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
