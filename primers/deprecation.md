---
title: Deprecation Domain
description: How to deprecate and remove symbols, endpoints, and behaviors safely.
---

# Deprecation Domain

## Mental Models

**Deprecation Is Communication, Not Deletion** — A deprecation notice is a promise to users: "this still works today, but you need to migrate before the sunset date." The act of deprecating a symbol, endpoint, or behavior is distinct from removing it. Conflating the two produces either premature breakage or symbols that linger forever because no one feels safe removing them.

**Version Lifecycle Has Phases** — Every public interface moves through: stable → deprecated → removed. Each transition needs a distinct signal: stable interfaces have no marker, deprecated interfaces carry warnings and migration pointers, removed interfaces are gone with a clear error rather than silent absence. Skipping the middle phase forces consumers to discover breakage at the wrong time.

**Migration Paths Are First-Class Deliverables** — A deprecation without a migration path is a complaint, not a plan. The migration guide (code samples, automated codemods, replacement API docs) should ship alongside the deprecation notice, not weeks later. Consumers cannot migrate to something that doesn't exist yet.

**Backward Compatibility Windows Must Be Explicit** — "We'll remove it eventually" is not a policy. Every deprecation needs a concrete sunset date or version. Without one, deprecated surfaces accumulate indefinitely, the codebase carries dead weight, and consumers never feel urgency to migrate.

## Decision Frameworks

**When to deprecate vs. when to break** — Deprecate when you have external consumers, a published contract, or a promise of stability (semver major, public API, documented endpoint). Break immediately only when the surface was never stable (internal-only, experimental, pre-1.0), when the security risk of keeping it outweighs migration cost, or when the migration is trivial and automatable with zero manual effort.

**Sunset timeline selection** — Base the window on consumer migration effort, not on your release cadence. A one-line rename needs days. A behavioral change affecting dozens of integration patterns needs quarters. Default to longer than feels necessary: you can always remove earlier if adoption metrics confirm migration is complete, but you cannot un-break a consumer who missed a short window.

**How to communicate deprecation** — Layer the signal: runtime warnings at point of use (log, console, compiler diagnostic), docs updated to show replacement prominently, changelog entry in the release introducing the deprecation, and direct outreach for high-impact consumers. Do not rely on any single channel — changelog-only deprecations are invisible to teams that only read runtime output.

**Measuring migration progress before removal** — Before removing a deprecated surface, gather evidence: usage analytics, search for call sites in known consumer repos, ask in community channels. Removal without evidence trades correctness for schedule.

## Failure Modes

**Silent deprecation** — Marking a symbol deprecated in docs or comments without any runtime or compile-time warning. Consumers who don't read changelogs have no signal. The deprecation is invisible until removal, at which point breakage looks unexpected.

**Premature removal** — Removing a surface before the announced sunset date, before a migration path exists, or before tracking confirms consumers have migrated. Even one committed consumer encountering unexpected breakage erodes trust in the entire versioning contract.

**Deprecation without migration path** — Announcing that something will go away without providing a viable replacement. Consumers may know they need to change but have nowhere to go, so they stay on the deprecated surface and apply pressure to delay removal indefinitely.

**Accumulating deprecated surfaces** — Deprecating liberally without following through on removal. The codebase fills with zombie APIs — kept alive by deprecation notices that nobody enforces. Over time the cost of understanding the codebase grows and the real API surface becomes ambiguous.

## Guardrails

**Deprecation without a removal plan** — You should deprecate with a clear sunset. If you're adding a deprecation notice without a target version or date for removal and a tracking issue, you've gone too far. A deprecation with no removal plan is just a permanent warning.

**Removing before the sunset date** — You should honor your versioning contract. If you're removing a deprecated symbol before the announced sunset date because it's inconvenient to maintain, you've gone too far. Early removal breaks the trust that makes versioning meaningful.

**Deprecating too eagerly** — You should stabilize before deprecating. If you're deprecating an interface that was just introduced, hasn't shipped in a stable release, or has no known consumers, you've gone too far. Premature deprecation creates churn without delivering migration value.

**Deprecation theater** — You should make migrations achievable. If you're adding `@deprecated` annotations and migration docs that point to a replacement API that doesn't exist yet or isn't production-ready, you've gone too far. Consumers cannot act on guidance toward a destination that isn't ready.
