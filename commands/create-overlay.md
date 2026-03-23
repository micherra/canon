---
name: create-overlay
description: Create a new role overlay for Canon agent prompt injection
---

# /canon:create-overlay

Create a new role overlay interactively.

## Process

1. **Show existing overlays** using `list_overlays` tool

2. **Interview the user:**
   - "What expertise domain?" (e.g., performance, security, accessibility, data)
   - "Name for this overlay?" (kebab-case)
   - "One-line description?"
   - "Which agents should this apply to?" Show the agent roster:
     - canon-implementor
     - canon-reviewer
     - canon-architect
     - canon-tester
     - canon-security
     - canon-researcher
     - (or "all" for universal)
   - "Priority?" (default 500, higher = injected earlier)

3. **Interview for content:**
   - "What heuristics should agents follow?" (implementation guidance)
   - "What should reviewers specifically check?" (review lens)
   - "Any anti-patterns to flag?" (things to avoid)

4. **Generate the overlay file:**
   ```yaml
   ---
   name: {name}
   description: {description}
   applies_to: [{agents}]
   priority: {priority}
   ---

   ## {Domain} Heuristics

   {heuristics}

   ## Review Lens

   {review criteria}

   ## Anti-Patterns

   {anti-patterns}
   ```

5. **Save** to `.canon/overlays/{name}.md`
6. **Verify** by calling `list_overlays` to confirm it appears
