/**
 * Frontmatter Schema Check (R1, ADR-0018) — per-class Zod validation of artifact
 * frontmatter, surfaced as a lint pass.
 *
 * Canon authors several markdown artifact classes with YAML frontmatter, but only
 * loops/routines validate theirs (at their own loaders). Principle frontmatter is
 * read via untyped `||`-coercion in `parser.ts` — a typo'd `severity` silently
 * becomes `"convention"`. Agents/templates/ADRs have no schema at all. This check
 * validates each file's frontmatter against the matching per-class schema and
 * surfaces typo'd / missing / wrong-shape values as findings.
 *
 * LINT-ONLY (ADR-0018): this does NOT touch `parsePrinciple`'s runtime coercion —
 * the parser stays lenient (degraded-load resilience); this is a separate read-only
 * pass that drives the deterministic CI gate. Loops/routines are excluded (already
 * Zod-validated at their loaders — no double coverage).
 *
 * Pure, no I/O: receives pre-loaded `rawFrontmatter` strings (the fence-slice + file
 * read happen in `tools/wiki-lint.ts`). Mirrors the `checkScopeLayers`/`checkScopeTags`
 * pure-IO split.
 *
 * Canon principles:
 * - pure-io-service-split: all I/O in the tool layer, not here
 * - functions-do-one-thing: one schema per class, one validating pass
 * - validate-at-trust-boundaries: Zod is the validation boundary for frontmatter
 */

import { parse as parseYaml } from "yaml";
import { z } from "zod";

// ---- Class resolution ----

export type FmClass = "principle" | "agent" | "template" | "adr";

/**
 * Resolve the artifact class for a repo-relative path by directory prefix.
 *
 * Loops/routines are intentionally NOT classified (they validate their own
 * frontmatter at load time — including them here would double-cover). Index
 * artifacts (README.md, TEMPLATE.md) carry no per-class frontmatter and are skipped.
 *
 * Prefix logic is replicated locally (small, <10 lines) rather than imported from
 * `graph/md-relations.ts` — diagnostics must not cross-feature-import (ADR-0005).
 */
export function classifyFmClass(repoRelPath: string): FmClass | null {
  const path = repoRelPath.split("\\").join("/");
  const base = path.slice(path.lastIndexOf("/") + 1);

  // Skip directory-doc / index files that legitimately lack a per-class schema.
  if (base === "README.md" || base === "TEMPLATE.md" || base === "CLAUDE.md") return null;
  // Skip anything under a dot-dir other than `.canon/` (e.g. `principles/.claude/`) —
  // those are tooling docs, not schema-bearing artifacts. `.canon/principles/` IS a
  // real principle tree, so it is exempt from this skip.
  if (path.split("/").some((seg) => seg.startsWith(".") && seg !== ".canon")) return null;

  // principle: a .md directly under a `*/principles/<tier>/` tree (any depth of tier).
  if (/(^|\/)principles\/[^/]+\/[^/]+\.md$/.test(path)) return "principle";
  if (/(^|\/)agents\/[^/]+\.md$/.test(path)) return "agent";
  if (/(^|\/)templates\/[^/]+\.md$/.test(path)) return "template";
  if (/(^|\/)docs\/adr\/\d{4}-[^/]+\.md$/.test(path)) return "adr";
  return null;
}

// ---- Per-class schemas ----

/**
 * Principle `scope`. All three keys are optional in the real corpus: principles
 * declare any non-empty subset of `layers` / `file_patterns` / `tags` (some have
 * only `layers`, some only `file_patterns`), and `parser.ts` coerces every absent
 * one with `|| []`. The schema mirrors that genuine contract — requiring any single
 * key would be a false positive on dozens of valid principles. The protection it
 * still gives: when a key IS present, it must be a string array (catches a scalar
 * typo like `layers: hooks`).
 */
const ScopeSchema = z.object({
  file_patterns: z.array(z.string()).optional(),
  layers: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
});

/**
 * Principle frontmatter. Mirrors the `Principle` type in `parser.ts`, but as a
 * VALIDATING schema — `severity` is the field that silently coerces today.
 * `.passthrough()` tolerates additional legitimate fields without false positives.
 */
const principleSchema = z
  .object({
    archived: z.union([z.boolean(), z.literal("true"), z.literal("false")]).optional(),
    id: z.string().min(1),
    portable: z.boolean().optional(),
    scope: ScopeSchema,
    severity: z.enum(["rule", "strong-opinion", "convention"]),
    // Top-level `tags` is optional: some principles carry only `scope.*` and no
    // top-level tags, and `parser.ts` coerces the absent value with `|| []`.
    tags: z.array(z.string()).optional(),
    title: z.string().min(1),
  })
  .passthrough();

const agentSchema = z
  .object({
    description: z.string().min(1),
    model: z.string().min(1),
    name: z.string().min(1),
    rules: z.array(z.string()),
  })
  .passthrough();

/**
 * Template frontmatter. Only `template` + `description` are universally present;
 * `used-by`, `read-by`, and `output-path` vary across the real corpus (e.g.
 * `planning-brief` has no `output-path`, `loop-definition` declares only the two
 * required keys). The optional fields are still type-checked when present.
 */
const templateSchema = z
  .object({
    description: z.string().min(1),
    "output-path": z.string().min(1).optional(),
    "read-by": z.array(z.string()).optional(),
    template: z.string().min(1),
    "used-by": z.array(z.string()).optional(),
  })
  .passthrough();

const adrSchema = z
  .object({
    adr: z.string().regex(/^\d{4}$/, 'adr must be a 4-digit string (e.g. "0042")'),
    build: z.string().min(1),
    date: z.string().min(1),
    status: z.enum(["accepted", "proposed", "superseded", "deprecated"]),
    title: z.string().min(1),
  })
  .passthrough();

const FRONTMATTER_SCHEMAS: Record<FmClass, z.ZodType> = {
  adr: adrSchema,
  agent: agentSchema,
  principle: principleSchema,
  template: templateSchema,
};

// ---- Check ----

export type FrontmatterSchemaInput = {
  path: string;
  fm_class: FmClass;
  rawFrontmatter: string;
};

export type FrontmatterSchemaFinding = {
  file_path: string;
  fm_class: FmClass;
  code: "PARSE_ERROR" | "SCHEMA_ERROR";
  message: string;
};

/** Summarize Zod issues into a single compact message (path: message; …). */
function summarizeZodError(error: z.ZodError): string {
  return error.issues
    .map((i) => {
      const at = i.path.length > 0 ? i.path.join(".") : "(root)";
      return `${at}: ${i.message}`;
    })
    .join("; ");
}

/** Validate one file's frontmatter against its class schema. */
function checkOne(input: FrontmatterSchemaInput): FrontmatterSchemaFinding | null {
  // No frontmatter fence at all → not a schema-bearing artifact (e.g. prose
  // templates like `domain-primer.md`). The tool layer passes "" when the fence
  // regex misses; treat that as "skip", not "missing required fields".
  if (input.rawFrontmatter.trim().length === 0) return null;

  let data: unknown;
  try {
    // Empty / comment-only frontmatter parses to null → treat as {} so the schema
    // reports the missing required fields (a SCHEMA_ERROR), not a PARSE_ERROR.
    data = parseYaml(input.rawFrontmatter) ?? {};
  } catch (err) {
    return {
      code: "PARSE_ERROR",
      file_path: input.path,
      fm_class: input.fm_class,
      message: `frontmatter YAML failed to parse: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const result = FRONTMATTER_SCHEMAS[input.fm_class].safeParse(data);
  if (result.success) return null;

  return {
    code: "SCHEMA_ERROR",
    file_path: input.path,
    fm_class: input.fm_class,
    message: summarizeZodError(result.error),
  };
}

/**
 * Validate a set of pre-loaded artifact frontmatters against their per-class
 * schemas. Returns one finding per invalid file (malformed YAML → PARSE_ERROR;
 * schema-invalid → SCHEMA_ERROR). Pure: no I/O.
 */
export function checkFrontmatterSchema(
  files: FrontmatterSchemaInput[],
): FrontmatterSchemaFinding[] {
  const findings: FrontmatterSchemaFinding[] = [];
  for (const file of files) {
    const finding = checkOne(file);
    if (finding) findings.push(finding);
  }
  return findings;
}
