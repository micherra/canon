import { readFile } from "fs/promises";

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
  body: string;
  filePath: string;
}

export function parseFrontmatter(content: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: content };
  }

  const [, yamlStr, body] = match;
  const frontmatter: Record<string, unknown> = {};

  let currentKey = "";
  let currentParent = "";
  const lines = yamlStr.split("\n");

  for (const line of lines) {
    // Skip empty lines
    if (line.trim() === "") continue;

    // Top-level key: value
    const topMatch = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (topMatch) {
      const [, key, value] = topMatch;
      currentKey = key;
      currentParent = "";

      if (value.trim() === "") {
        // Could be a parent key (object or array follows)
        frontmatter[key] = {};
      } else if (value.startsWith("[")) {
        // Inline array
        frontmatter[key] = parseInlineArray(value);
      } else {
        frontmatter[key] = value.replace(/^["']|["']$/g, "");
      }
      continue;
    }

    // Nested key (2 spaces): "  key: value"
    const nestedMatch = line.match(/^  (\w[\w-]*):\s*(.*)$/);
    if (nestedMatch) {
      const [, key, value] = nestedMatch;
      currentParent = currentKey;
      currentKey = key;

      if (typeof frontmatter[currentParent] !== "object" || Array.isArray(frontmatter[currentParent])) {
        frontmatter[currentParent] = {};
      }

      const parent = frontmatter[currentParent] as Record<string, unknown>;
      if (value.trim() === "") {
        parent[key] = [];
      } else if (value.startsWith("[")) {
        parent[key] = parseInlineArray(value);
      } else {
        parent[key] = value.replace(/^["']|["']$/g, "");
      }
      continue;
    }

    // Array item (2 or 4 spaces): "  - value" or "    - value"
    const arrayMatch = line.match(/^\s+- (.+)$/);
    if (arrayMatch) {
      const value = arrayMatch[1].replace(/^["']|["']$/g, "");

      if (currentParent && typeof frontmatter[currentParent] === "object" && !Array.isArray(frontmatter[currentParent])) {
        const parent = frontmatter[currentParent] as Record<string, unknown>;
        if (!Array.isArray(parent[currentKey])) {
          parent[currentKey] = [];
        }
        (parent[currentKey] as string[]).push(value);
      } else {
        if (!Array.isArray(frontmatter[currentKey])) {
          frontmatter[currentKey] = [];
        }
        (frontmatter[currentKey] as string[]).push(value);
      }
      continue;
    }
  }

  return { frontmatter, body: body.trim() };
}

function parseInlineArray(value: string): string[] {
  const inner = value.replace(/^\[/, "").replace(/\].*$/, "");
  if (inner.trim() === "") return [];
  return inner
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter((s) => s !== "");
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
    body,
    filePath,
  };
}

export async function loadPrincipleFile(filePath: string): Promise<Principle> {
  const content = await readFile(filePath, "utf-8");
  return parsePrinciple(content, filePath);
}
