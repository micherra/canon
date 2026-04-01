import { readFile } from "node:fs/promises";
import matter from "gray-matter";

export interface PrincipleScope {
  layers: string[];
  file_patterns: string[];
}

export interface Principle {
  id: string;
  title: string;
  severity: "rule" | "strong-opinion" | "convention";
  scope: PrincipleScope;
  tags: string[];
  archived: boolean;
  body: string;
  filePath: string;
}

export function parseFrontmatter(content: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  const parsed = matter(content);
  return {
    frontmatter: parsed.data as Record<string, unknown>,
    body: parsed.content.trim(),
  };
}

export function parsePrinciple(content: string, filePath: string): Principle {
  const { frontmatter, body } = parseFrontmatter(content);

  const scope = (frontmatter.scope as Record<string, unknown>) || {};

  return {
    id: (frontmatter.id as string) || "",
    title: (frontmatter.title as string) || "",
    severity: (frontmatter.severity as Principle["severity"]) || "convention",
    scope: {
      layers: (scope.layers as string[]) || [],
      file_patterns: (scope.file_patterns as string[]) || [],
    },
    tags: (frontmatter.tags as string[]) || [],
    archived: frontmatter.archived === "true" || frontmatter.archived === true,
    body,
    filePath,
  };
}

export async function loadPrincipleFile(filePath: string): Promise<Principle> {
  const content = await readFile(filePath, "utf-8");
  return parsePrinciple(content, filePath);
}
