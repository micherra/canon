import { readFile } from "node:fs/promises";
import matter from "gray-matter";
import { PRINCIPLE_SECTIONS } from "./constants.ts";

type PrincipleScope = {
  layers: string[];
  file_patterns: string[];
  /** Optional tags for cross-cutting matching via computed file tags from the KG. */
  tags?: string[];
};

export type Principle = {
  id: string;
  title: string;
  severity: "rule" | "strong-opinion" | "convention";
  scope: PrincipleScope;
  tags: string[];
  archived: boolean;
  portable?: boolean;
  body: string;
  filePath: string;
  anti_rationalization?: string;
  verification?: string;
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
 */
export const filterBodyBySections = (
  body: string,
  anti_rationalization: string | undefined,
  verification: string | undefined,
  sections: string[],
): string => {
  const sectionMap: Record<string, { heading: string; content: string | undefined }> = {
    anti_rationalization: {
      content: anti_rationalization,
      heading: PRINCIPLE_SECTIONS.ANTI_RATIONALIZATION,
    },
    verification: {
      content: verification,
      heading: PRINCIPLE_SECTIONS.VERIFICATION,
    },
  };

  if (!sections || sections.length === 0) {
    // Return full body with all extracted sections re-attached.
    const parts = [body];
    for (const { heading, content } of Object.values(sectionMap)) {
      if (content !== undefined) {
        parts.push(`## ${heading}\n\n${content}`);
      }
    }
    return parts.join("\n\n");
  }

  // Return summary paragraph + requested sections only.
  const summary = body.split(/\n\n/)[0]?.trim() ?? body;
  const parts = [summary];

  for (const key of sections) {
    const entry = sectionMap[key];
    if (entry?.content !== undefined) {
      parts.push(`## ${entry.heading}\n\n${entry.content}`);
    }
  }

  return parts.join("\n\n");
};

export function parseFrontmatter(content: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  const parsed = matter(content);
  return {
    body: parsed.content.trim(),
    frontmatter: parsed.data as Record<string, unknown>,
  };
}

/** Map a raw frontmatter `portable` value to `true`, `false`, or `undefined`. */
function parsePortable(value: unknown): boolean | undefined {
  if (value === true) return true;
  if (value === false) return false;
  return undefined;
}

export function parsePrinciple(content: string, filePath: string): Principle {
  const { frontmatter, body: rawBody } = parseFrontmatter(content);
  const { sections, remainder } = extractSections(rawBody);

  const scope = (frontmatter.scope as Record<string, unknown>) || {};

  const principle: Principle = {
    archived: frontmatter.archived === "true" || frontmatter.archived === true,
    body: remainder,
    filePath,
    id: (frontmatter.id as string) || "",
    portable: parsePortable(frontmatter.portable),
    scope: {
      file_patterns: (scope.file_patterns as string[]) || [],
      layers: (scope.layers as string[]) || [],
      tags: (scope.tags as string[]) || undefined,
    },
    severity: (frontmatter.severity as Principle["severity"]) || "convention",
    tags: (frontmatter.tags as string[]) || [],
    title: (frontmatter.title as string) || "",
  };

  const antiRat = sections.get(PRINCIPLE_SECTIONS.ANTI_RATIONALIZATION);
  if (antiRat !== undefined) {
    principle.anti_rationalization = antiRat;
  }

  const verification = sections.get(PRINCIPLE_SECTIONS.VERIFICATION);
  if (verification !== undefined) {
    principle.verification = verification;
  }

  return principle;
}

export async function loadPrincipleFile(filePath: string): Promise<Principle> {
  const content = await readFile(filePath, "utf-8");
  return parsePrinciple(content, filePath);
}
