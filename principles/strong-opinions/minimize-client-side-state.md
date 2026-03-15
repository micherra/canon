---
id: minimize-client-side-state
title: Minimize Client-Side State
severity: strong-opinion
scope:
  layers:
    - ui
  file_patterns:
    - "src/**"
    - "**/*.tsx"
    - "**/*.vue"
    - "**/*.svelte"
tags:
  - ui
  - state-management
  - complexity
  - patterns
---

Keep client-side state to the minimum needed for the UI to function. Derive what you can compute, don't cache what the server owns, and never store the same data in two places. Every piece of state is a synchronization obligation — the less state you hold, the fewer bugs you ship.

## Rationale

The most common category of frontend bugs is state synchronization: a cached value drifts from its source, two copies of the same data disagree, or a derived value isn't recomputed when its inputs change. Every `useState` call is a commitment to keep that value correct for the lifetime of the component. The fewer commitments, the fewer ways to break.

*Frontend Architecture for Design Systems* and *Modern Front-End Architecture* both emphasize that component complexity should be proportional to the component's responsibility. A component that duplicates server state into local state, then synchronizes it back on save, then invalidates a cache, has four opportunities to go wrong where a component that reads directly from the server has one.

AI-generated code is especially prone to redundant state. Asked to "show a filtered list," the LLM creates `useState` for the full list, `useState` for the filtered list, and `useState` for the filter value — then adds a `useEffect` to synchronize the filtered list whenever the full list or filter changes. The `useEffect` is the symptom; the redundant state is the disease.

## Examples

**Bad — derived values stored as separate state:**

```tsx
function ProductList({ products }: { products: Product[] }) {
  const [searchTerm, setSearchTerm] = useState("");
  const [filteredProducts, setFilteredProducts] = useState(products);
  const [resultCount, setResultCount] = useState(products.length);

  useEffect(() => {
    const filtered = products.filter(p =>
      p.name.toLowerCase().includes(searchTerm.toLowerCase())
    );
    setFilteredProducts(filtered);   // redundant state — derivable
    setResultCount(filtered.length); // redundant state — derivable from derivable
  }, [products, searchTerm]);

  return (
    <div>
      <SearchInput value={searchTerm} onChange={setSearchTerm} />
      <span>{resultCount} results</span>
      {filteredProducts.map(p => <ProductCard key={p.id} product={p} />)}
    </div>
  );
}
```

Three pieces of state where one suffices. The `useEffect` synchronization can cause a flash of stale data on every render.

**Good — one piece of state, the rest derived:**

```tsx
function ProductList({ products }: { products: Product[] }) {
  const [searchTerm, setSearchTerm] = useState("");

  const filteredProducts = useMemo(
    () => products.filter(p =>
      p.name.toLowerCase().includes(searchTerm.toLowerCase())
    ),
    [products, searchTerm]
  );

  return (
    <div>
      <SearchInput value={searchTerm} onChange={setSearchTerm} />
      <span>{filteredProducts.length} results</span>
      {filteredProducts.map(p => <ProductCard key={p.id} product={p} />)}
    </div>
  );
}
```

One state variable (`searchTerm`). Everything else is computed. No synchronization, no stale data, no extra re-renders.

## Exceptions

Performance-critical derivations that are expensive to recompute on every render may justify caching in state — but reach for `useMemo` or framework-level caching first, not a separate `useState` + `useEffect` pair. Optimistic UI updates that temporarily diverge from server state are a deliberate, bounded exception — the local state exists to make the UI feel fast while the server catches up, and it's reconciled when the response arrives.

**Related:** `unidirectional-data-flow` ensures what state does exist flows predictably through the component tree.
