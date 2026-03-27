---
name: create-flow
description: Interactive flow author — creates new Canon flow definitions with validation
---

# /canon:create-flow

Create a new Canon flow definition interactively.

## Process

1. **Show existing flows** for reference:
   - Call `load_flow` for each existing flow to show names and descriptions

2. **Interview the user:**
   - "What should this flow be called?" (kebab-case name)
   - "Describe what this flow does" (one-line description)
   - "What tier?" (small/medium/large, or omit for auto-detect)
   - "What states do you need?" Show a menu:
     - research (canon-researcher, parallel)
     - design (canon-architect, single)
     - implement (canon-implementor, wave)
     - test (canon-tester, single)
     - review (canon-reviewer, single or parallel-per)
     - security (canon-security, single)
     - fix (canon-fixer, parallel-per)
     - ship (canon-shipper, terminal)
     - custom (user describes)
   - "Which fragments to include?" Show available fragments from `flows/fragments/`

3. **Generate the flow file:**
   - YAML frontmatter with states, transitions, and settings
   - Markdown body with `### state-id` spawn instruction stubs
   - Follow the format in `flows/SCHEMA.md`

4. **Save** to `flows/{name}.md`

## Tips
- Default transitions: `done: next-state`, `blocked: hitl`
- Every flow needs at least one terminal state
- Include `entry:` if the first state in the YAML isn't the entry point
- Use `review-fix` fragment for review→fix loops
