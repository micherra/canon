---
adr: "0018"
title: "Frontmatter is validated by a per-class schema registry, surfaced as a lint gate (parser stays lenient)"
status: accepted
date: "2026-06-21"
build: "markdown-corpus-integrity-swap-gray-matteryaml-option-a-then-add-two"
---

# ADR-0018: Per-class frontmatter schema registry, lint-only

## Context

Canon authors five+ markdown artifact classes with YAML frontmatter: principles, agents, templates, ADRs, loops, routines. Only `loops` and `routines` validate their frontmatter against a Zod schema (at their own loaders). Principle frontmatter is read by `shared/parser.ts:parsePrinciple` via **untyped `||`-fallback coercion**: `severity: (fm.severity as …) || "convention"`, `scope: (fm.scope as …) || {}`. A typo'd `severity: rül` silently becomes `"convention"`; a malformed `scope` silently becomes `{}`. Agents, templates, and ADRs have no schema at all. Frontmatter errors therefore fail **silently** (wrong-but-well-formed values) — there is no gate that says "this artifact's frontmatter is invalid."

Separately, the build that introduced this ADR swapped `gray-matter` → the `yaml` lib behind a `splitFrontmatter` seam (see the exploration assessment `.canon/explore/gray-matter-replacement-assessment.md`); malformed YAML still *throws* at load time as before — that is the crash contract, distinct from the silent value-coercion this ADR addresses.

## Decision

1. **A single per-class schema registry** lives in `features/diagnostics/services/frontmatter-schema.ts`: `FRONTMATTER_SCHEMAS: Record<FmClass, ZodType>` keyed by `"principle" | "agent" | "template" | "adr"`. Artifact class is resolved from the file's directory prefix. Loops/routines are excluded (already validated at their loaders — no double coverage).

2. **The schema is surfaced as a `wiki_lint` check (`frontmatter_schema`), NOT as parser hardening.** `parsePrinciple` keeps its lenient `||`-coercion at runtime. A malformed/wrong principle still **loads degraded** rather than crashing the server mid-flow; the deterministic lint/CI gate is what catches the error.

3. New artifact classes plug a schema into the one registry rather than adding a new ad-hoc validating loader.

## Rationale

- **Why lint-not-harden:** `parsePrinciple` feeds principle loading and `matcher.ts` across the whole server. Making it throw on schema-invalid frontmatter changes load-time behavior with high blast radius and real regression risk, for no benefit the lint pass doesn't already provide. Load-time resilience and authoring-correctness are different concerns: the parser owns the former (stay lenient), the gate owns the latter (be strict). This mirrors Canon's existing split where `checkScopeLayers`/`checkScopeTags` lint principle scope without the loader rejecting it.
- **Why one registry:** the silent-coercion gap exists because validation was per-loader and most loaders simply omit it. A single registry makes "every class has a schema" a structural property, not a per-loader choice that can be forgotten (the same failure mode that left agents/templates/ADRs unvalidated).
- **Determinism:** the check is pure over loaded frontmatter with sorted, timestamp-free output → CI/pre-commit-gate suitable, satisfying the deterministic-gate invariant.

## Consequences

- A typo'd `severity`, missing required key, malformed YAML block, or non-4-digit ADR number becomes a reported `frontmatter_schema` finding (`SCHEMA_ERROR` / `PARSE_ERROR`) instead of a silent default.
- The registry is the extension point: a future artifact class adds one schema entry + one path-prefix mapping.
- The parser's lenient coercion remains; consumers that relied on degraded-load behavior are unaffected.
- `frontmatter_schema` joins the `CheckName` union and `WIKI_LINT_CHECK_NAMES` (schema-parity enforced).
