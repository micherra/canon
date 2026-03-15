---
id: compose-from-small-to-large
title: Compose UI from Small to Large
severity: strong-opinion
scope:
  layers:
    - ui
  file_patterns:
    - "src/components/**"
    - "src/ui/**"
    - "src/pages/**"
    - "**/*.tsx"
    - "**/*.vue"
    - "**/*.svelte"
tags:
  - ui
  - components
  - design-systems
  - composition
---

Build UI by composing small, self-contained components into progressively larger ones — atoms into molecules, molecules into organisms, organisms into pages. Start with the smallest reusable pieces (a button, an input, an avatar) and compose upward. Never start with a page-level component and try to decompose downward after the fact.

## Rationale

*Frontend Architecture for Design Systems* draws on Brad Frost's atomic design methodology to argue that sustainable design systems are built bottom-up. Small components are easy to test, easy to document in a style guide, and easy to reuse across features. A `<Button>` composed with an `<Icon>` and a `<Tooltip>` gives you an `<IconButton>` — each piece is independently testable and swappable.

The opposite approach — building a `<CheckoutPage>` monolith and trying to extract reusable pieces later — produces components that carry hidden assumptions about their context. The "extracted" button still expects checkout-specific props, the card layout only works at the checkout page's width, and the form field assumes a specific validation library.

AI-generated code strongly favors top-down construction. Given "build a settings page," the LLM produces one large component tree and inlines everything. The resulting code works but yields zero reusable pieces. Enforcing bottom-up composition means the LLM first builds the small pieces, then assembles them — producing a component library as a side effect of building the feature.

## Examples

**Bad — top-down monolith with inlined sub-components:**

```tsx
function SettingsPage() {
  return (
    <div className="settings">
      <div className="settings-header">
        <img src={user.avatar} className="avatar-lg" />
        <div>
          <h1 style={{ fontSize: 24 }}>{user.name}</h1>
          <span style={{ color: "#6b7280" }}>{user.email}</span>
        </div>
      </div>
      <div className="settings-section">
        <h2>Notifications</h2>
        <div className="toggle-row">
          <span>Email notifications</span>
          <button onClick={toggleEmail}>
            {emailEnabled ? "On" : "Off"}
          </button>
        </div>
        <div className="toggle-row">
          <span>Push notifications</span>
          <button onClick={togglePush}>
            {pushEnabled ? "On" : "Off"}
          </button>
        </div>
      </div>
    </div>
  );
}
```

Nothing is reusable. The avatar, the toggle row, and the section heading are all inlined.

**Good — composed from small, reusable pieces:**

```tsx
// Atoms
function Avatar({ src, alt, size }: AvatarProps) { /* ... */ }
function Toggle({ label, enabled, onToggle }: ToggleProps) { /* ... */ }
function SectionHeading({ children }: { children: ReactNode }) { /* ... */ }

// Molecules
function UserHeader({ user }: { user: User }) {
  return (
    <header>
      <Avatar src={user.avatar} alt={user.name} size="lg" />
      <div>
        <h1>{user.name}</h1>
        <span>{user.email}</span>
      </div>
    </header>
  );
}

// Organism
function NotificationSettings({ settings, onUpdate }: NotificationSettingsProps) {
  return (
    <section>
      <SectionHeading>Notifications</SectionHeading>
      <Toggle label="Email notifications" enabled={settings.email} onToggle={() => onUpdate("email")} />
      <Toggle label="Push notifications" enabled={settings.push} onToggle={() => onUpdate("push")} />
    </section>
  );
}

// Page — pure composition
function SettingsPage() {
  const user = useUser();
  const [settings, updateSettings] = useNotificationSettings();

  return (
    <PageLayout>
      <UserHeader user={user} />
      <NotificationSettings settings={settings} onUpdate={updateSettings} />
    </PageLayout>
  );
}
```

`Avatar`, `Toggle`, and `SectionHeading` are reusable across any feature. `UserHeader` and `NotificationSettings` are domain-specific compositions. The page only orchestrates.

## Exceptions

Prototypes and one-off internal tools where speed outweighs reusability can be built top-down. Highly unique, page-specific layouts that genuinely won't repeat (a marketing landing page with a bespoke hero section) don't need to be decomposed into atoms. The principle applies most strongly to product UI where components recur across features.

**Related:** `component-single-responsibility` ensures each composed piece has one job. `design-tokens-as-style-contract` provides the visual consistency that makes small components look cohesive when composed together.
