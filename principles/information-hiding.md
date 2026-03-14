---
id: information-hiding
title: Each Module Hides a Design Decision
severity: strong-opinion
scope:
  languages: []
  layers: []
tags:
  - encapsulation
  - coupling
  - ousterhout
---

Each module should encapsulate a design decision so that changing that decision requires editing only that module. If knowledge about data formats, algorithms, storage mechanisms, or wire protocols appears in multiple files, information is leaking. The test: "If I change how X works, how many files do I touch?" If the answer is more than one, X is leaking.

## Rationale

Information leakage is the most common cause of high coupling in codebases. It's subtler than code duplication — the same *knowledge* is encoded in multiple places even when the *code* looks different. When a developer changes a database column from `created_at` to `createdAt`, they shouldn't need to update handler code, serialization logic, and test fixtures in separate files. The decision about column naming should live in one place.

This is distinct from DRY. DRY says "don't repeat code." Information hiding says "don't repeat *decisions*." Two modules can have completely different code but still leak information if they both embed assumptions about the same design decision.

A common form is temporal decomposition — splitting code into modules based on the order of execution (read step, parse step, process step, write step) rather than by what knowledge each step encapsulates. Each step ends up knowing about the data format, creating tight coupling.

AI-generated code is especially prone to information leakage because LLMs generate code file-by-file. When generating `parser.ts`, then `validator.ts`, then `formatter.ts`, the LLM independently encodes the same format assumptions in each file. It doesn't track which design decisions should be centralized — it makes each file self-contained, which means each file re-embeds shared knowledge.

## Examples

**Bad — format knowledge leaked across modules:**

```typescript
// parser.ts
function parseLogLine(line: string): LogEntry {
  const parts = line.split("|");
  return { timestamp: parts[0], level: parts[1], message: parts[2] };
}

// formatter.ts — knows the same pipe-delimited format
function formatLogEntry(entry: LogEntry): string {
  return `${entry.timestamp}|${entry.level}|${entry.message}`;
}

// validator.ts — also knows the format
function isValidLogLine(line: string): boolean {
  return line.split("|").length === 3;
}
```

Three modules all encode the knowledge that logs are pipe-delimited with three fields. Changing to JSON requires editing all three.

**Good — format knowledge encapsulated in one module:**

```typescript
// log-format.ts — owns the format decision
const LOG_SEPARATOR = "|";
const LOG_FIELDS = ["timestamp", "level", "message"] as const;

export function parse(line: string): LogEntry {
  const parts = line.split(LOG_SEPARATOR);
  return Object.fromEntries(LOG_FIELDS.map((f, i) => [f, parts[i]])) as LogEntry;
}

export function format(entry: LogEntry): string {
  return LOG_FIELDS.map((f) => entry[f]).join(LOG_SEPARATOR);
}

export function isValid(line: string): boolean {
  return line.split(LOG_SEPARATOR).length === LOG_FIELDS.length;
}
```

Changing the format (e.g., to JSON) requires editing one file.

## Exceptions

Some information is intentionally shared as a contract — API schemas, database migration definitions, and protocol buffer definitions exist to be the single source of truth that multiple modules read from. The key distinction: a shared schema *is* the encapsulation point. The problem is when the knowledge is duplicated rather than referenced.
