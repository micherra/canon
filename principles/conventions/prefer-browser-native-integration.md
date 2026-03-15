---
id: prefer-browser-native-integration
title: Prefer Browser-Native APIs for Cross-Module Communication
severity: convention
scope:
  layers:
    - ui
  file_patterns:
    - "src/**"
    - "packages/**"
    - "apps/**"
tags:
  - ui
  - micro-frontends
  - web-platform
  - integration
---

When frontend modules need to communicate across boundaries — micro frontends exchanging data, a shell notifying feature modules, or independently deployed widgets coordinating — prefer browser-native mechanisms (Custom Events, `BroadcastChannel`, URL/query parameters, `postMessage`) over custom pub/sub libraries, shared global event buses, or framework-specific solutions. Native APIs work regardless of the framework each module uses and introduce no shared runtime dependency.

## Rationale

*The Art of Micro Frontends* advises: "Favor native browser features over custom APIs." A custom event bus becomes a shared dependency that all modules must agree on, version, and import. If it's a singleton on `window`, it's a global mutable object. If it's an npm package, it's a build-time coupling point. Either way, it undermines the module independence the architecture was designed to provide.

Browser-native events are already the universal integration layer. Every framework can dispatch and listen for DOM events. `CustomEvent` carries typed payloads. `BroadcastChannel` works across tabs. `postMessage` works across iframes and web workers. These APIs are stable, well-documented, and available everywhere — no installation, no versioning, no framework lock-in.

*Modern Front-End Architecture* reinforces this by noting that the simplest composition patterns — links, URLs, and native browser navigation — are also the most resilient. The web platform itself is the integration framework.

## Examples

**Bad — custom shared event bus creates coupling:**

```typescript
// shared/event-bus.ts — every module must import this
class EventBus {
  private listeners = new Map<string, Set<Function>>();
  on(event: string, fn: Function) { /* ... */ }
  off(event: string, fn: Function) { /* ... */ }
  emit(event: string, data: unknown) { /* ... */ }
}

export const bus = new EventBus();  // singleton on the module graph

// Module A
import { bus } from "@company/shared/event-bus";
bus.emit("cart:updated", { items: cart.items });

// Module B
import { bus } from "@company/shared/event-bus";
bus.on("cart:updated", (data) => updateBadge(data.items.length));
```

Both modules share a build-time dependency. If the event bus package changes its API, both must update simultaneously.

**Good — browser-native Custom Events:**

```typescript
// Module A — dispatches a native event, no shared import
function notifyCartUpdate(items: CartItem[]) {
  window.dispatchEvent(
    new CustomEvent("cart:updated", {
      detail: { itemCount: items.length, total: calculateTotal(items) },
    })
  );
}

// Module B — listens with standard DOM API
useEffect(() => {
  const handler = (e: CustomEvent) => {
    setBadgeCount(e.detail.itemCount);
  };
  window.addEventListener("cart:updated", handler);
  return () => window.removeEventListener("cart:updated", handler);
}, []);
```

Zero shared code. Module A could be React, Module B could be Vue — neither cares. The contract is the event name and its `detail` shape.

## Exceptions

Within a single module or team-owned micro frontend, framework-native state management (React Context, Vuex/Pinia, NgRx) is the right tool — the isolation boundary is between modules, not within them. High-frequency communication (60fps drag coordination, streaming data updates) may justify a shared library optimized for performance over the general-purpose event system. In these cases, document the coupling explicitly and version the shared contract.

**Related:** `isolate-frontend-runtime-state` explains why shared runtime state is the failure mode that this communication pattern prevents.
