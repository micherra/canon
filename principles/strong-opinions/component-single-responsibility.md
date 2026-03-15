---
id: component-single-responsibility
title: Each UI Component Serves One Purpose
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
  - design-systems
  - modularity
---

Every UI component should be created for a single, focused reason and should do that one thing extremely well. A component that renders a user avatar should not also fetch user data, manage tooltip state, and handle navigation. Split rendering, data-fetching, and behavioral concerns into separate components or hooks so each piece can be understood, tested, and reused independently.

## Rationale

Micah Godbolt's *Frontend Architecture for Design Systems* elevates the single responsibility principle to the organizing rule for scalable design systems. When a component owns one responsibility, changing it affects only that responsibility — you can restyle a button without risking the form validation logic that lives elsewhere. When a component serves multiple purposes, every change risks collateral damage across unrelated features.

AI-generated frontend code gravitates toward "god components" — a single `<Dashboard>` that fetches data, transforms it, manages filters, renders charts, and handles exports. The LLM produces the shortest path to a working demo, but the result is untestable and unreusable. Enforcing single responsibility at the component level counteracts this tendency and produces components that compose cleanly into larger features.

In micro-frontend architectures, single-responsibility components are the building blocks that allow teams to own and deploy slices of the UI independently. A component that mixes concerns from two domains cannot be cleanly assigned to one team.

## Examples

**Bad — one component doing everything:**

```tsx
function UserProfile({ userId }: { userId: string }) {
  const [user, setUser] = useState<User | null>(null);
  const [posts, setPosts] = useState<Post[]>([]);
  const [isEditing, setIsEditing] = useState(false);
  const [formData, setFormData] = useState({});
  const [activeTab, setActiveTab] = useState("posts");

  useEffect(() => {
    fetch(`/api/users/${userId}`).then(r => r.json()).then(setUser);
    fetch(`/api/users/${userId}/posts`).then(r => r.json()).then(setPosts);
  }, [userId]);

  const handleSave = async () => {
    await fetch(`/api/users/${userId}`, {
      method: "PUT",
      body: JSON.stringify(formData),
    });
    setIsEditing(false);
  };

  return (
    <div>
      {isEditing ? (
        <form onSubmit={handleSave}>
          {/* 50 lines of form fields */}
        </form>
      ) : (
        <div>
          <img src={user?.avatar} />
          <h1>{user?.name}</h1>
          <Tabs active={activeTab} onChange={setActiveTab}>
            <Tab id="posts">{posts.map(p => <PostCard post={p} />)}</Tab>
            <Tab id="settings">{/* 30 lines of settings UI */}</Tab>
          </Tabs>
        </div>
      )}
    </div>
  );
}
```

**Good — each component has one job:**

```tsx
function UserProfile({ userId }: { userId: string }) {
  const user = useUser(userId);           // data-fetching in a hook
  const posts = useUserPosts(userId);     // separate data concern

  return (
    <ProfileLayout>
      <UserHeader user={user} />
      <ProfileTabs
        posts={<PostList posts={posts} />}
        settings={<ProfileSettings userId={userId} />}
      />
    </ProfileLayout>
  );
}

function UserHeader({ user }: { user: User }) {
  return (
    <header>
      <Avatar src={user.avatar} alt={user.name} />
      <h1>{user.name}</h1>
    </header>
  );
}
```

Each component renders one thing. Data-fetching lives in hooks. The profile page composes single-purpose pieces.

## Exceptions

Leaf components that combine a small amount of local state with rendering (a `<Toggle>` managing its own open/closed state) are fine — the state is intrinsic to the component's single purpose. Prototype or throwaway UI where speed matters more than maintainability can bend this rule, but convert to single-responsibility components before the prototype becomes production code.

**Related:** `functions-do-one-thing` applies the same single-responsibility constraint at the function level; this principle applies it at the UI component level.
