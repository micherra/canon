---
id: props-are-the-component-contract
title: Props Are the Component Contract
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
  - api-design
  - design-systems
---

A component's props (or attributes, or inputs) are its public API — the stable contract that consumers depend on. Keep the props interface minimal: accept only what the component needs to do its job, and nothing more. Internals can change freely between releases; the props contract must remain stable. When you design a component, design its props first.

## Rationale

*Frontend Architecture for Design Systems* treats component APIs as the primary design artifact — more important than the implementation behind them. A `<Modal>` with a clean props interface (`isOpen`, `onClose`, `title`, `children`) can be reimplemented from scratch without breaking a single consumer. A `<Modal>` that accepts a configuration object with 30 optional fields locks every consumer into the current implementation's quirks.

Minimal props also enforce separation of concerns. If a `<UserCard>` accepts a `user: User` prop, it can render any user. If it accepts `userId: string` and fetches the user internally, it's coupled to a specific data source and can't be used in a story, a test, or a different context without mocking the network.

AI-generated components tend toward props bloat — accepting large objects and configuration maps because it's the shortest path to making the component "flexible." The result is a component that knows too much about its consumers and breaks when any part of the configuration shape changes.

## Examples

**Bad — over-broad props that leak implementation details:**

```tsx
interface DataTableProps {
  config: {
    columns: ColumnDef[];
    data: unknown[];
    pagination: { page: number; pageSize: number; total: number };
    sorting: { field: string; direction: "asc" | "desc" } | null;
    filtering: Record<string, string>;
    onStateChange: (state: TableState) => void;  // one callback for everything
    theme: "light" | "dark";
    stickyHeader: boolean;
    virtualScroll: boolean;
    rowSelection: { enabled: boolean; selected: Set<string> };
    contextMenu: { items: MenuItem[] } | null;
    exportOptions: { formats: string[] };
  };
}

<DataTable config={massiveConfigObject} />
```

One monolithic config object. Changing any internal feature means changing the config shape, which breaks every consumer.

**Good — minimal, focused props:**

```tsx
interface DataTableProps {
  columns: ColumnDef[];
  data: Row[];
  onRowSelect?: (rowId: string) => void;
  onSort?: (field: string, direction: SortDirection) => void;
}

<DataTable
  columns={columns}
  data={filteredData}
  onRowSelect={handleSelect}
  onSort={handleSort}
/>
```

Four props. The table renders data and reports interactions. Pagination, filtering, and export are handled by the parent or by composing with other components. The table can add virtual scrolling, sticky headers, or context menus internally without changing its props.

**Bad — component fetches its own data, limiting reuse:**

```tsx
function UserCard({ userId }: { userId: string }) {
  const [user, setUser] = useState<User | null>(null);

  useEffect(() => {
    fetch(`/api/users/${userId}`).then(r => r.json()).then(setUser);
  }, [userId]);

  if (!user) return <Skeleton />;
  return <div>{user.name}</div>;
}
```

Can't be used in a story without a running API server. Can't display a user from a different data source.

**Good — component accepts the data it needs:**

```tsx
function UserCard({ user }: { user: User }) {
  return <div>{user.name}</div>;
}

// The parent decides where data comes from
function UserList() {
  const users = useUsers();
  return users.map(u => <UserCard key={u.id} user={u} />);
}
```

`UserCard` works with any `User` object — from an API, from a test fixture, from a Storybook arg.

## Exceptions

Components that encapsulate a complete feature (a `<RichTextEditor>`, a `<MapWidget>`) may legitimately accept a configuration object — the config is their contract, and the internals are genuinely complex. The distinction: a config object is acceptable when it represents the component's domain model, not when it's a grab-bag of implementation toggles. Also, data-fetching components (containers, route-level components) that exist specifically to bridge data and UI may accept identifiers and fetch internally — the point is that the presentational components beneath them accept data, not identifiers.

**Related:** `component-single-responsibility` ensures each component has a focused purpose, which naturally leads to a minimal props interface. `compose-from-small-to-large` produces components whose narrow props make them easy to compose.

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
