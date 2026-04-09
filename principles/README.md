# Canon Principles

This directory contains Canon's engineering principles — encoded guidelines that describe what good code looks like in the systems Canon works on. Principles are the shared vocabulary for code quality: they give reviewers and implementors a common language for talking about architectural decisions, and they give Canon's automated review tools the criteria they need to flag problems.

## The Three Tiers

Principles are organized by enforcement severity into three subdirectories.

**Rules** are non-negotiable. They cover failure modes with no legitimate exceptions in production code: secrets in source files, missing trust-boundary validation, privilege escalation risks. Rules are enforced pre-commit — a rule violation blocks the commit until it's fixed. There are currently four rules in Canon, deliberately few, because if everything is non-negotiable then nothing is.

**Strong opinions** are where most of Canon's design guidance lives. These cover architecture patterns (bounded contexts, command-query separation, error handling), data patterns (schema migrations, normalization strategy), testing patterns (one behavior per test, contract testing), and deployment patterns. Deviating from a strong opinion is not a blocker, but it requires explicit justification — reviewers will flag it and ask why.

**Conventions** are best practices that Canon recommends but does not enforce. They cover naming, file organization, test structure, and similar consistency concerns. Deviations are noted but not blocking.

This three-tier structure matters because it forces Canon's authors to be honest about the cost of enforcement. Every rule creates friction — it slows down every developer, every time, on every change. That friction is worth it for failure modes that are both common and catastrophic. It is not worth it for style preferences.

## Principle File Format

Each principle is a markdown file with YAML frontmatter:

```yaml
---
id: principle-name-in-kebab-case
title: Human-Readable Title
severity: rule | strong-opinion | convention
tags: [relevant, topic, tags]
scope:
  layers: [domain, infrastructure, ...]
---
```

The body follows a consistent structure: a one-paragraph statement of the constraint, a rationale section explaining why the constraint exists, examples of compliant and non-compliant code, and an exceptions section listing any bounded cases where the principle doesn't apply. Stronger principles also include an anti-rationalization table addressing the common excuses for violating the principle.

## How Principles Are Used

The Canon MCP server loads principles through its `get_principles` and `review_code` tools. When the reviewer or security agent analyzes code, the server filters the principle set by the code's layer, file patterns, and tags to surface the most relevant constraints. The `canon-learner` agent proposes new or updated principles when it spots recurring patterns. The `canon-writer` agent creates the actual principle files following Canon's format.

Principles are also referenced in compliance declarations that implementors include in their task summaries, creating an audit trail of which principles were applied to which work.

## The Learning Loop

Canon's principles are not static. The learner agent analyzes completed builds and flagged violations to propose refinements: principles that are too broad, too narrow, or that have accumulated enough real-world exceptions to warrant a scope adjustment. Principles get better over time as they are tested against actual code.

If you encounter a pattern that no existing principle captures — or find that a principle is regularly being applied in ways that feel wrong — that's a signal to engage the writer agent.
