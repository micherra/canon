import { readFile } from "node:fs/promises";
import matter from "gray-matter";

export type PrincipleScope = {
  layers: string[];
  file_patterns: string[];
};

export type Principle = {
  id: string;
  title: string;
  severity: "rule" | "strong-opinion" | "convention";
  scope: PrincipleScope;
  tags: string[];
  archived: boolean;
  body: string;
  filePath: string;
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

export function parsePrinciple(content: string, filePath: string): Principle {
  const { frontmatter, body } = parseFrontmatter(content);

  const scope = (frontmatter.scope as Record<string, unknown>) || {};

  return {
    archived: frontmatter.archived === "true" || frontmatter.archived === true,
    body,
    filePath,
    id: (frontmatter.id as string) || "",
    scope: {
      file_patterns: (scope.file_patterns as string[]) || [],
      layers: (scope.layers as string[]) || [],
    },
    severity: (frontmatter.severity as Principle["severity"]) || "convention",
    tags: (frontmatter.tags as string[]) || [],
    title: (frontmatter.title as string) || "",
  };
}

export async function loadPrincipleFile(filePath: string): Promise<Principle> {
  const content = await readFile(filePath, "utf-8");
  return parsePrinciple(content, filePath);
}
