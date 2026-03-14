---
id: services-own-their-data
title: Each Service Owns Its Data Store Exclusively
severity: strong-opinion
scope:
  languages: []
  layers:
    - domain
    - data
tags:
  - microservices
  - data-ownership
  - coupling
---

Each service must own its data store exclusively. No service reads from or writes to another service's database directly. Data sharing happens through service APIs or published events. A shared database between services is shared mutable state at the architectural level — it couples deployment, scaling, and schema evolution across services that should be independent.

## Rationale

*Building Microservices* identifies shared databases as the single most common mistake in microservice architectures. When two services share a database, they share a schema — and a schema change in one service can break the other. They cannot be deployed independently (migration coordination), scaled independently (shared connection pool), or use different storage technologies (both locked to the same database).

The failure mode: service A adds an index to improve its query performance, and service B's write performance degrades because they share the same table. Or: service A needs to migrate to a new schema version, but service B isn't ready for the migration, so both services are blocked. The shared database creates invisible coupling that only manifests under load or during migrations.

## Examples

**Bad — services sharing a database:**

```typescript
// Order service directly queries user service's database
async function getOrderWithUser(orderId: string) {
  const order = await orderDb.query("SELECT * FROM orders WHERE id = $1", [orderId]);
  // Directly accessing the user service's table — tight coupling!
  const user = await userDb.query("SELECT * FROM users WHERE id = $1", [order.userId]);
  return { ...order, user };
}
```

```typescript
// Two services sharing the same database connection
// services/orders/config.ts
export const db = new PrismaClient({ datasources: { db: { url: SHARED_DB_URL } } });

// services/billing/config.ts
export const db = new PrismaClient({ datasources: { db: { url: SHARED_DB_URL } } });
// Same DB URL = same database = coupled services
```

**Good — services own their data, share via APIs or events:**

```typescript
// Order service calls user service API for user data
async function getOrderWithUser(orderId: string): Promise<OrderWithUser> {
  const order = await orderDb.query("SELECT * FROM orders WHERE id = $1", [orderId]);
  const userResult = await userServiceClient.getUser(order.userId);
  if (!userResult.ok) return { ...order, user: null }; // Graceful degradation
  return { ...order, user: userResult.data };
}

// Or: maintain a local read model via events
async function handleUserUpdated(event: UserUpdatedEvent) {
  // Order service keeps its own copy of the user data it needs
  await orderDb.query(
    "INSERT INTO order_user_cache (user_id, name, email) VALUES ($1, $2, $3) ON CONFLICT (user_id) DO UPDATE SET name = $2, email = $3",
    [event.userId, event.name, event.email]
  );
}
```

## Exceptions

Read replicas used for cross-service analytics and reporting are acceptable when they are explicitly read-only and consumers understand the data is eventually consistent. Shared reference data that genuinely never changes (country codes, currency codes, timezone definitions) may live in a shared schema or library. During a migration from monolith to microservices, temporary shared database access may be necessary as an intermediate step — but it should be explicitly time-boxed.
