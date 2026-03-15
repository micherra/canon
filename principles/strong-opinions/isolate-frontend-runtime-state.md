---
id: isolate-frontend-runtime-state
title: Isolate Runtime State Between Frontend Modules
severity: strong-opinion
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
  - state-management
  - modularity
---

Frontend modules — whether micro frontends, independently deployed packages, or team-owned feature areas — must not share runtime state through global variables, shared stores, or singleton services. Each module owns its own state. When modules need to communicate, they exchange messages through well-defined events or narrow, read-only APIs — never by mutating a shared object.

## Rationale

Florian Rappl's *The Art of Micro Frontends* states the rule directly: "Don't share a runtime, even if all teams use the same framework. Build independent apps that are self-contained." Shared global state is the most common way micro-frontend architectures silently revert to monolithic coupling. Two teams both read from `window.__APP_STATE__` and suddenly neither can deploy without the other.

The failure mode is insidious. It works fine in development when one team controls everything. It works fine in staging when deployments happen together. It fails in production at 2 AM when Team A deploys a change that reshapes the shared state object and Team B's module crashes because it expected the old shape. There's no compile-time check, no type boundary, no contract — just a shared mutable object and a silent assumption that everyone agrees on its structure.

*Modern Front-End Architecture* reinforces this: modular frontends achieve scalability through isolation. The moment two modules couple on internal state, you lose the ability to deploy, test, and reason about them independently.

## Examples

**Bad — shared global state between modules:**

```typescript
// shared/global-store.ts — used by multiple micro frontends
export const globalStore = {
  user: null as User | null,
  cart: [] as CartItem[],
  notifications: [] as Notification[],
};

// Module A — writes to global store
globalStore.user = await fetchUser();

// Module B — reads from global store, tightly coupled to its shape
function CartSummary() {
  const itemCount = globalStore.cart.length;
  const userName = globalStore.user?.name;  // breaks if Module A changes user shape
  return <span>{userName}'s cart: {itemCount} items</span>;
}
```

**Good — modules communicate through events:**

```typescript
// Module A — publishes a typed event when user loads
const userLoaded = new CustomEvent("user:loaded", {
  detail: { userId: user.id, displayName: user.name },
});
window.dispatchEvent(userLoaded);

// Module B — subscribes, owns its own state
function CartSummary() {
  const [userName, setUserName] = useState<string>("");
  const cart = useCartStore();  // module-local store

  useEffect(() => {
    const handler = (e: CustomEvent) => setUserName(e.detail.displayName);
    window.addEventListener("user:loaded", handler);
    return () => window.removeEventListener("user:loaded", handler);
  }, []);

  return <span>{userName}'s cart: {cart.items.length} items</span>;
}
```

Each module owns its state. The event contract is narrow (userId + displayName), not the entire user object. Module B keeps working even if Module A changes its internal user representation.

## Exceptions

A thin, read-only shared context — like a current locale, feature flags, or authenticated user ID provided by the application shell — is acceptable when it's injected at the top level and treated as immutable by consumers. The key distinction: the shell provides configuration, not mutable application state. Within a single micro frontend or team-owned module, shared state management (Redux, Zustand, Pinia) is perfectly fine — the isolation boundary is between modules, not within them.

**Related:** `prefer-browser-native-integration` describes the specific browser-native mechanisms to use when implementing this isolation pattern.
