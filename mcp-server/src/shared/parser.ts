import { readFile } from "node:fs/promises";
import { PRINCIPLE_SECTIONS } from "./constants.ts";
import { splitFrontmatter } from "./lib/frontmatter.ts";
import {
  brandUntrusted,
  rawUntrustedForStructuralUse,
  type UntrustedText,
} from "./lib/overlay-untrusted-text.ts";

type PrincipleScope = {
  layers: string[];
  file_patterns: string[];
  /** Optional tags for cross-cutting matching via computed file tags from the KG. */
  tags?: string[];
};

export type Principle = {
  id: string;
  /** Free-text title from frontmatter — opaque box; must render via renderUntrusted* for model output. */
  title: UntrustedText;
  severity: "rule" | "strong-opinion" | "convention";
  scope: PrincipleScope;
  /** Charset-validated closed-domain tags (^[a-z0-9_-]+$); injection strings dropped at load. */
  tags: string[];
  archived: boolean;
  portable?: boolean;
  /** Free-text body — opaque box; must render via renderUntrusted* for model output. */
  body: UntrustedText;
  filePath: string;
  /** Free-text anti-rationalization section — opaque box. */
  anti_rationalization?: UntrustedText;
  /** Free-text verification section — opaque box. */
  verification?: UntrustedText;
  /** Origin of the principle: "project" = project-local .canon/principles/ (untrusted),
   *  "plugin" = built-in plugin/principles/ (trusted). Stamped by loadAllPrinciples;
   *  undefined for principles loaded without origin context (treated as trusted). */
  source?: "project" | "plugin";
};

/** Known section heading values for case-insensitive matching. */
const KNOWN_SECTIONS = new Map(Object.values(PRINCIPLE_SECTIONS).map((v) => [v.toLowerCase(), v]));

/**
 * Splits a principle body by `## ` headings, extracting known sections
 * (Anti-Rationalization, Verification) into a Map and returning the
 * remainder (preamble + unknown sections) as a trimmed string.
 */
export const extractSections = (
  body: string,
): { sections: Map<string, string>; remainder: string } => {
  const sections = new Map<string, string>();

  // Split on newline-prefixed ## headings; the first chunk is the preamble.
  const parts = body.split(/\n(?=## )/);
  const remainderParts: string[] = [];

  for (const part of parts) {
    const headingMatch = part.match(/^## (.+?)(?:\n|$)/);
    if (headingMatch) {
      const headingText = headingMatch[1].trim();
      const canonical = KNOWN_SECTIONS.get(headingText.toLowerCase());
      if (canonical) {
        const content = part.slice(headingMatch[0].length).trim();
        sections.set(canonical, content);
        continue;
      }
    }
    remainderParts.push(part);
  }

  return { remainder: remainderParts.join("\n").trim(), sections };
};

/**
 * Filters principle body content by requested section names.
 *
 * - When `sections` is empty, returns the full body with all extracted sections
 *   re-attached.
 * - When `sections` is non-empty, returns only the summary paragraph (first
 *   paragraph of remainder) plus the requested section content.
 *
 * Section name keys: `"anti_rationalization"` and `"verification"`.
 *
 * Brand-preserving: accepts UntrustedText inputs; uses rawUntrustedForStructuralUse
 * internally for text manipulation; returns a new UntrustedText — callers must
 * still pass through renderUntrusted* for model-facing output.
 */
export const filterBodyBySections = (
  body: UntrustedText,
  anti_rationalization: UntrustedText | undefined,
  verification: UntrustedText | undefined,
  sections: string[],
): UntrustedText => {
  // Extract raw strings for text manipulation — this is a brand-preserving
  // structural operation, NOT a model-facing output path.
  const rawBody = rawUntrustedForStructuralUse(body);
  const rawAntiRat =
    anti_rationalization !== undefined
      ? rawUntrustedForStructuralUse(anti_rationalization)
      : undefined;
  const rawVerif =
    verification !== undefined ? rawUntrustedForStructuralUse(verification) : undefined;

  const sectionMap: Record<string, { heading: string; content: string | undefined }> = {
    anti_rationalization: {
      content: rawAntiRat,
      heading: PRINCIPLE_SECTIONS.ANTI_RATIONALIZATION,
    },
    verification: {
      content: rawVerif,
      heading: PRINCIPLE_SECTIONS.VERIFICATION,
    },
  };

  if (sections.length === 0) {
    // Return full body with all extracted sections re-attached.
    const parts = [rawBody];
    for (const { heading, content } of Object.values(sectionMap)) {
      if (content !== undefined) {
        parts.push(`## ${heading}\n\n${content}`);
      }
    }
    return brandUntrusted(parts.join("\n\n"));
  }

  // Return summary paragraph + requested sections only.
  const summary = rawBody.split(/\n\n/)[0]?.trim() ?? rawBody;
  const parts = [summary];

  for (const key of sections) {
    const entry = sectionMap[key];
    if (entry?.content !== undefined) {
      parts.push(`## ${entry.heading}\n\n${entry.content}`);
    }
  }

  return brandUntrusted(parts.join("\n\n"));
};

export function parseFrontmatter(content: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  const { data, body } = splitFrontmatter(content);
  return {
    body: body.trim(),
    frontmatter: data,
  };
}

/** Map a raw frontmatter `portable` value to `true`, `false`, or `undefined`. */
function parsePortable(value: unknown): boolean | undefined {
  if (value === true) return true;
  if (value === false) return false;
  return undefined;
}

// Charset for principle id — closed identifier domain; non-matching ids produce the empty-id
// sentinel which matcher.ts:161 filters out (same posture as the routine name gate).
const PRINCIPLE_ID_CHARSET = /^[a-z0-9_-]+$/;
// Valid severity enum values; anything else defaults to "convention" (safe default).
const VALID_SEVERITIES = new Set(["rule", "strong-opinion", "convention"]);

// Charset regexes for closed-domain array fields (B-layer: validate at load boundary).
/** Tags and scope.tags: lowercase alphanumeric, hyphen, underscore. */
const TAG_CHARSET = /^[a-z0-9_-]+$/;
/** scope.layers: same closed identifier domain as tags. */
const LAYER_CHARSET = /^[a-z0-9_-]+$/;
/** scope.file_patterns: glob characters allowed in addition to alphanumerics. */
const FILE_PATTERN_CHARSET = /^[A-Za-z0-9._*/{}!,()-]+$/;

/**
 * Fail-closed id charset guard. Returns `true` when the id is acceptable (empty ids
 * are allowed — matcher.ts:161 filters them downstream). Emits a warn and returns
 * `false` for non-empty ids that contain characters outside [a-z0-9_-].
 */
function isValidPrincipleId(rawId: string, filePath: string): boolean {
  if (!rawId) return true;
  if (PRINCIPLE_ID_CHARSET.test(rawId)) return true;
  console.warn(
    `[canon] parsePrinciple: id '${rawId}' does not match ^[a-z0-9_-]+$ — skipping (${filePath})`,
  );
  return false;
}

/** Empty-id sentinel returned for principles with invalid ids. Filtered by matcher.ts. */
function emptyPrincipleSentinel(filePath: string): Principle {
  return {
    archived: false,
    body: brandUntrusted(""),
    filePath,
    id: "",
    scope: { file_patterns: [], layers: [] },
    severity: "convention",
    tags: [],
    title: brandUntrusted(""),
  };
}

/** Severity enum guard — injection strings default to the safe "convention" value. */
function parseSeverity(raw: string | undefined): Principle["severity"] {
  return (VALID_SEVERITIES.has(raw ?? "") ? raw : "convention") as Principle["severity"];
}

/**
 * Charset-filter an array of tag strings. Non-matching entries are dropped
 * (warn-and-drop posture — injection strings are silently excluded, not passed through).
 */
function filterTagArray(raw: string[], label: string, filePath: string): string[] {
  return raw.filter((t) => {
    if (TAG_CHARSET.test(t)) return true;
    console.warn(
      `[canon] parsePrinciple: ${label} '${t}' failed charset ^[a-z0-9_-]+$ — dropping (${filePath})`,
    );
    return false;
  });
}

/**
 * Charset-filter scope.layers. Drops non-matching entries with a warn.
 */
function filterLayers(raw: string[], filePath: string): string[] {
  return raw.filter((l) => {
    if (LAYER_CHARSET.test(l)) return true;
    console.warn(
      `[canon] parsePrinciple: scope.layers '${l}' failed charset ^[a-z0-9_-]+$ — dropping (${filePath})`,
    );
    return false;
  });
}

/**
 * Charset-filter scope.file_patterns. Drops non-matching entries with a warn.
 */
function filterFilePatterns(raw: string[], filePath: string): string[] {
  return raw.filter((p) => {
    if (FILE_PATTERN_CHARSET.test(p)) return true;
    console.warn(
      `[canon] parsePrinciple: scope.file_patterns '${p}' failed charset — dropping (${filePath})`,
    );
    return false;
  });
}

export function parsePrinciple(content: string, filePath: string): Principle {
  const { frontmatter, body: rawBody } = parseFrontmatter(content);
  const { sections, remainder } = extractSections(rawBody);

  const rawId = (frontmatter.id as string) || "";
  if (!isValidPrincipleId(rawId, filePath)) return emptyPrincipleSentinel(filePath);

  const scope = (frontmatter.scope as Record<string, unknown>) || {};

  const principle: Principle = {
    archived: frontmatter.archived === "true" || frontmatter.archived === true,
    // Brand the free-text body at the load boundary.
    body: brandUntrusted(remainder),
    filePath,
    id: rawId,
    portable: parsePortable(frontmatter.portable),
    scope: {
      // Charset-filter closed-domain array fields at the load boundary (B-layer).
      file_patterns: filterFilePatterns((scope.file_patterns as string[]) || [], filePath),
      layers: filterLayers((scope.layers as string[]) || [], filePath),
      tags: Array.isArray(scope.tags)
        ? filterTagArray(scope.tags as string[], "scope.tags", filePath)
        : undefined,
    },
    severity: parseSeverity(frontmatter.severity as string | undefined),
    tags: filterTagArray((frontmatter.tags as string[]) || [], "tags", filePath),
    // Brand the free-text title at the load boundary.
    title: brandUntrusted((frontmatter.title as string) || ""),
  };

  const antiRat = sections.get(PRINCIPLE_SECTIONS.ANTI_RATIONALIZATION);
  if (antiRat !== undefined) {
    principle.anti_rationalization = brandUntrusted(antiRat);
  }

  const verification = sections.get(PRINCIPLE_SECTIONS.VERIFICATION);
  if (verification !== undefined) {
    principle.verification = brandUntrusted(verification);
  }

  return principle;
}

export async function loadPrincipleFile(filePath: string): Promise<Principle> {
  const content = await readFile(filePath, "utf-8");
  return parsePrinciple(content, filePath);
}
