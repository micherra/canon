---
id: unidirectional-data-flow
title: Data Flows Down, Events Flow Up
severity: strong-opinion
scope:
  layers:
    - ui
  file_patterns:
    - "src/components/**"
    - "src/ui/**"
    - "**/*.tsx"
    - "**/*.vue"
    - "**/*.svelte"
tags:
  - ui
  - components
  - state-management
  - patterns
---

Data flows down the component tree through props. When a child needs to change something, it fires an event or calls a callback passed down by the parent — it never reaches up to mutate a parent's state directly. The parent decides what to do with the event. This one-way flow makes state changes predictable and traceable: you always know where data comes from (above) and where change requests go (above).

## Rationale

Every major frontend framework converges on unidirectional data flow as the default mental model — React's props-down/callbacks-up, Vue's one-way prop binding with `$emit`, Svelte's `bind:` being explicit opt-in. The reason is debuggability: when data only flows in one direction, you can trace any bug by following the prop chain upward to its source. When children can mutate parent state directly, you get invisible action-at-a-distance — a deeply nested component changes a value and the entire tree re-renders for reasons nobody can trace.

*Frontend Architecture for Design Systems* argues that predictable component behavior is the foundation of a composable design system. A `<DatePicker>` that secretly mutates a form state object above it can't be used outside that specific form. A `<DatePicker>` that calls `onChange(selectedDate)` works anywhere.

AI-generated code frequently violates this principle by passing mutable objects as props and modifying them in place, or by using refs to reach into parent components. The code works in the immediate context but creates invisible coupling that breaks when the component is reused elsewhere. This is one of the most common LLM-generated antipatterns: the shortest path to "working" code is a shared mutable object, and the LLM takes it every time.

## Examples

**Bad — child mutates parent state directly:**

```tsx
// Parent passes a mutable object
function OrderForm() {
  const formState = useRef({ items: [], shipping: null, total: 0 });

  return (
    <div>
      <ItemSelector state={formState.current} />
      <ShippingPicker state={formState.current} />
      <OrderTotal state={formState.current} />
    </div>
  );
}

// Child reaches in and mutates the shared object
function ItemSelector({ state }: { state: FormState }) {
  const addItem = (item: Item) => {
    state.items.push(item);                    // mutates parent's object
    state.total = state.items.reduce(          // recalculates on parent's behalf
      (sum, i) => sum + i.price, 0
    );
  };

  return <ProductGrid onSelect={addItem} />;
}
```

`ItemSelector` knows about `total` and mutates it — a responsibility that belongs to the parent. `ShippingPicker` might also recalculate `total`, creating a race.

**Good — data down, events up:**

```tsx
function OrderForm() {
  const [items, setItems] = useState<Item[]>([]);
  const [shipping, setShipping] = useState<ShippingOption | null>(null);

  const total = useMemo(
    () => calculateTotal(items, shipping),
    [items, shipping]
  );

  return (
    <div>
      <ItemSelector onAdd={(item) => setItems([...items, item])} />
      <ShippingPicker onSelect={setShipping} />
      <OrderTotal total={total} />
    </div>
  );
}

function ItemSelector({ onAdd }: { onAdd: (item: Item) => void }) {
  return <ProductGrid onSelect={onAdd} />;
}
```

`ItemSelector` knows nothing about totals or shipping. It reports what happened (an item was selected) and the parent decides what to do. `total` is derived in one place.

## Exceptions

Two-way binding for form inputs (`v-model` in Vue, controlled inputs in React) is the pragmatic choice when the parent explicitly opts in — the binding is declared at the call site, not hidden inside the child. Global state managers (Redux, Zustand, Pinia) that use a dispatch/action model maintain unidirectional flow even though components can trigger state changes from anywhere — the change goes through a central, predictable reducer, not by mutating a prop.

**Related:** `minimize-client-side-state` reduces the amount of state flowing through the tree, making unidirectional flow simpler to maintain.
