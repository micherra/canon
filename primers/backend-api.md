---
title: Backend API Domain
description: Design and evolution guidance for backend API contracts, versioning, and consumer compatibility.
---

# Backend API Domain

## Mental Models

**Hyrum's Law** — With enough consumers, every observable behavior becomes a dependency. Not just your documented contract — response field ordering, error message wording, timing characteristics, undocumented fields. Design as if every response shape you ship is permanent, because it effectively is. This is why additive changes are safe and modifications are not.

**The Boundary Is the Product** — Internal code serves the system. The API boundary serves external consumers who can't see your internals and shouldn't need to. Every design decision at the boundary should be evaluated from the consumer's perspective: can they use this without reading the implementation? If not, the boundary is leaking.

## Decision Frameworks

**Error taxonomy** — Classify errors by who can act on them, not by what went wrong internally. Three categories cover most APIs: client errors (the caller sent something wrong and can fix it — 4xx), server faults (something broke on our side, the caller should retry or escalate — 5xx), and transient failures (temporary, retry with backoff). This drives response shape: client errors need enough detail to fix the request, server faults need a correlation ID for debugging, transient failures need a Retry-After hint.

**When to version** — Version when you must break the contract. Prefer extending the existing version (new optional fields, new endpoints) over creating a new version. A new version is two APIs to maintain, test, and eventually sunset. The decision point: can existing consumers ignore this change and keep working? If yes, extend. If no, version.

**Pagination strategy** — Choose based on data characteristics. Offset-based for stable, sortable data where users jump to arbitrary pages. Cursor-based for large, frequently-changing datasets where consistency matters more than random access. Keyset-based when you need cursor benefits with SQL simplicity. Default to cursor-based unless you have a specific reason for offset.

## Failure Modes

**Testing the mock instead of the contract** — Writing tests against a mocked API client that returns hardcoded shapes proves nothing about the actual boundary. The mock drifts from reality, tests pass, production breaks. Test against the real boundary (integration tests) or at minimum validate that your mock matches the actual response schema.

**Leaking internals through the boundary** — Returning database IDs as sequential integers (exposes record count and creation order), including internal field names that don't match the public concept, returning null for fields the consumer doesn't have permission to see instead of omitting them. The boundary should present the domain model, not the storage model.

**Implicit contracts** — Behaviors you didn't intend to promise but consumers depend on: response field order, exact error message strings in conditional logic, response times as implicit SLAs, undocumented fields that happen to be present. Every response you send is a promise you may not know you're making.

## Guardrails

**Error class explosion** — You should return consistent, categorized errors. If you're creating a unique error class or code for every possible failure path, you've gone too far. A handful of categories (NotFound, ValidationError, Conflict, InternalError, RateLimited) cover the vast majority of cases. Consumers parse categories, not individual codes.

**Defensive serialization** — You should control your response shape. If you're writing custom serializers for every response to defensively strip fields, you've gone too far. A shared response builder or DTO pattern applied once at the boundary layer handles this. Per-endpoint serialization is a sign the boundary isn't well-defined.

**Over-versioning** — You should version breaking changes. If you're creating a new API version for every additive change, or if you have more than 2-3 active versions, you've gone too far. Most changes are additive and don't require versioning. A proliferation of versions means consumers don't know which to use and you're maintaining parallel implementations.

**Premature pagination** — You should paginate list endpoints. If you're paginating an endpoint that will never return more than 50 items, or building cursor-based pagination for a simple lookup table, you've gone too far. Paginate when the dataset can realistically grow beyond what a single response should carry.
