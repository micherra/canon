# Backend Data Domain

## Mental Models

**Schema Is a Bet on the Future** — Every schema decision is a prediction about how the data will be queried, how it will grow, and what will change. Columns are cheap to add, expensive to remove. Tables are cheap to create, expensive to merge. Foreign keys are cheap to enforce, expensive to retrofit. The cost of a schema decision isn't what it takes to write the migration — it's what it takes to change it when the prediction is wrong.

**Reads and Writes Have Different Physics** — Write patterns are driven by business operations (create an order, update a status). Read patterns are driven by user interfaces and reports (show all orders for this customer, sorted by date, with totals). These forces pull in opposite directions — normalization optimizes for write consistency, denormalization optimizes for read performance. The schema serves both, but rarely equally.

**Migrations Are Deployments** — A migration runs against a live database with real data, real traffic, and real constraints. A migration that works on an empty dev database may lock a production table with 50 million rows for minutes. A migration that adds a NOT NULL column without a default will fail on tables with existing rows. Treat every migration with the same caution as a production deployment, because it is one.

## Decision Frameworks

**When to add an index** — Index columns that appear in WHERE clauses, JOIN conditions, and ORDER BY on queries that run frequently or against large tables. Don't index columns on small tables (full scan is faster than index lookup under ~1000 rows), columns with very low cardinality (boolean flags — the index doesn't help the optimizer), or columns that are mostly written and rarely queried. Composite indexes should match your most common query patterns, column order matters — leftmost column first.

**Nullable vs. default** — Use NULL when the absence of a value is meaningful and distinct from any real value (a user who hasn't set a preference is different from a user who chose the default). Use a default when every row should have a value and the absence case doesn't exist in the domain. NULL propagates through operations in surprising ways (NULL + 5 = NULL, NULL != NULL) — every nullable column adds conditional handling to every query that touches it.

**Cascade behavior** — RESTRICT (prevent delete if children exist) is the safe default — it forces the application to handle cleanup explicitly. CASCADE (delete children automatically) is appropriate for true composition relationships where children have no meaning without the parent (order → order_items). SET NULL is appropriate when the relationship is optional and the child should survive the parent's deletion. Choose deliberately rather than accepting the database default.

**When to denormalize** — Denormalization trades write complexity (keeping copies in sync) for read performance (avoiding joins); see `normalize-first-denormalize-intentionally` for the justification constraint. Common candidates: caching computed aggregates (order totals), embedding lookup values that never change (country names), materializing frequently-joined data for read-heavy paths.

## Failure Modes

**Schema that mirrors the API** — Designing tables to match the shape of API responses creates a storage model that's coupled to the presentation model. When the API needs a different view of the same data, you end up with redundant tables or awkward joins. The database should model the domain; the API layer should project from it.

**The migration that locks the table** — Adding a column with a default, creating an index without CONCURRENTLY (in Postgres), or changing a column type on a large table. All of these can acquire locks that block reads and writes for the duration. On a 10-row dev table this takes milliseconds. On a 50-million-row production table it takes minutes of downtime.

**N+1 in a loop** — Fetching a list of parents, then querying children for each parent in a loop. The symptom is a page that gets slower linearly with data size. The cause is always a missing JOIN or batch query. ORMs make this easy to write because they hide the query boundary — each `parent.children` access fires a separate query.

**Soft delete creep** — Adding an `is_deleted` flag instead of actually deleting rows. Every query now needs a `WHERE is_deleted = false` clause, which is easy to forget. Unique constraints stop working (you can't have two active users with the same email if the deleted one still occupies the unique slot). The table grows indefinitely. Soft delete is sometimes necessary (audit requirements, undo features) but should be a deliberate choice, not a default.

## Guardrails

**Index everything** — You should index query paths. If you're adding indexes to every column because it "might be queried," you've gone too far. Each index slows writes, consumes storage, and adds optimizer complexity. Index the queries you actually have, not the queries you imagine.

**Normalization purity** — You should normalize by default. If you're creating a lookup table for every repeated string or a junction table for a relationship that will never need metadata, you've gone too far. Normalization has diminishing returns — a status enum column is simpler than a statuses lookup table when there are five statuses that change once a year.

**Migration paranoia** — You should treat migrations carefully. If you're splitting every schema change into five incremental migrations with backward compatibility shims at each step for a table with 500 rows, you've gone too far. Migration complexity should be proportional to the data volume and traffic on the affected table.

**Premature partitioning** — You should plan for data growth. If you're partitioning tables before they have a million rows, or sharding a database that fits on a single machine with room to spare, you've gone too far. Partitioning and sharding add operational complexity that's only justified by actual scale problems.
