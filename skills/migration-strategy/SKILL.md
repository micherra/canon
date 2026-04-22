---
name: migration-strategy
description: Domain primer for large and long-running migrations. Covers expand-migrate-contract, backfill sizing, rollback windows, dual-write reconciliation, schema change ordering, and feature-flag cliff risk. Use when planning data migrations, schema changes with >1 release cycle, cross-service moves, or anything where readers and writers disagree for a period.
user-invocable: false
---

# Migration Strategy Domain

## Mental Models

**Expand, Migrate, Contract** — Every non-trivial migration is three phases, not one. Expand: introduce the new thing alongside the old, with writes going to both. Migrate: move readers over, backfill historical data. Contract: remove the old thing. The steps exist so rollback is always a step back, not a restore from backup. A "big bang" cutover is the absence of this discipline; it is also the absence of a safe rollback path.

**The Migration Is the Product, Briefly** — During a long-running migration, the migration state (percent cut over, which shards, which cohorts) becomes a thing users and engineers depend on understanding. Treat the migration as a first-class system with its own dashboard, its own runbook, its own on-call. Migrations that are "just a script someone ran" produce the ambiguous partial states that cause the worst post-migration bugs.

**Every Feature Flag Is a Branch in Production** — A flag behind which a migration runs is two code paths to verify, test, and maintain. The cost of having the flag is real; the cost of keeping it after the migration completes is higher. Set a flag-retirement date when you create the flag. Flags that outlive their migration become accidental toggles with unclear semantics.

## Decision Frameworks

**Backfill sizing** — Work out the "worst-hour-per-day" load from the migration itself and decide if it can run inline with production traffic. If backfill would double DB write load at peak, it must be throttled or offloaded (read replica, staging DB, batch window). Pick the throttle based on a measured steady-state baseline, not a guess; a backfill that takes 3x longer is usually fine, a backfill that takes down the DB is not.

**Rollback window** — Decide up front how long you keep the ability to roll back. Too short: a post-migration bug becomes an emergency. Too long: you maintain dual-write or shadow paths forever. A rule of thumb: dual-write at least one release cycle after the last reader moves, then a conservative additional window for bug discovery.

**Schema change ordering** — Additive first (new columns, new tables, nullable). Only after writers + readers agree on the new shape may you tighten (NOT NULL, FK constraints, DROP column). A schema change coupled with a code change is a deploy-order bug waiting to happen. Decouple the two by always making the schema change deploy-safe in both directions.

## Failure Modes

**Backfill drift** — The script that filled historical rows ran against the data as it was on Tuesday. Writes that happened on Wednesday are missing because the backfill window ended. Every backfill needs a catch-up phase that runs until "last backfilled" ≥ "last written," and then a verification pass that samples rows and confirms both paths agree.

**Dual-write inconsistency** — Writes to old and new systems are not transactional. Partial failures leave the two out of sync. Without a reconciliation pass, the divergence compounds until readers see stale data from whichever side they read. Every dual-write migration needs an ongoing reconciliation job until the old path is removed.

**Feature-flag cliff** — Flag flipped for 100% of users in one commit after weeks of partial rollout. The bugs that only appear at load show up during the 100% window with no ability to subdivide further. Roll out by cohort size, not by flag flip: 1% → 10% → 50% → 100%, each step with a bake time proportional to the next step's size.

**Dead old path** — After the migration, the old code, the old tables, the old flag, the old metric dashboards all linger. "It might be useful someday." It is not. It becomes the path that gets accidentally re-enabled during an incident response, the table that gets joined into a query six months later, the flag someone toggles not knowing what it does.

## Guardrails

**Migration without a rollback plan** — You should have a migration plan. If the plan has a forward path but no written "how do we undo this in the first hour / first day / first week," you've under-planned. Rollback steps need to be tested end-to-end, not just described.

**Custom migration harness** — You should have tooling for complex migrations. If you're building a generic migration framework with job scheduling, retries, progress tracking, and alerting from scratch for a one-off migration, you've gone too far. Use the simplest thing that works: a script + cron + a checkpoints table covers most cases.

**Silent migrations** — You should minimize operational surface area. If your migration has no dashboard, no alerts, no progress visibility, and you're finding out it's stalled when a user reports missing data, you've under-invested. A 1-day migration needs a progress bar; a 1-month migration needs a dashboard.

**Re-invention of idempotency** — You should handle retries safely. If every migration step re-implements idempotency from scratch (check exists, insert or skip, handle race), you've missed the pattern. A shared `migration_progress` table with step IDs and completion markers lets every step become "run until rows complete == rows expected."
