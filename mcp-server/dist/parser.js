import { readFile } from "fs/promises";
export function parseFrontmatter(content) {
    const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!match) {
        return { frontmatter: {}, body: content };
    }
    const [, yamlStr, body] = match;
    const frontmatter = {};
    let currentKey = "";
    let currentParent = "";
    const lines = yamlStr.split("\n");
    for (const line of lines) {
        // Skip empty lines
        if (line.trim() === "")
            continue;
        // Top-level key: value
        const topMatch = line.match(/^(\w[\w-]*):\s*(.*)$/);
        if (topMatch) {
            const [, key, value] = topMatch;
            currentKey = key;
            currentParent = "";
            if (value.trim() === "") {
                // Could be a parent key (object or array follows)
                frontmatter[key] = {};
            }
            else if (value.startsWith("[")) {
                // Inline array
                frontmatter[key] = parseInlineArray(value);
            }
            else {
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
            const parent = frontmatter[currentParent];
            if (value.trim() === "") {
                parent[key] = [];
            }
            else if (value.startsWith("[")) {
                parent[key] = parseInlineArray(value);
            }
            else {
                parent[key] = value.replace(/^["']|["']$/g, "");
            }
            continue;
        }
        // Array item (2 or 4 spaces): "  - value" or "    - value"
        const arrayMatch = line.match(/^\s+- (.+)$/);
        if (arrayMatch) {
            const value = arrayMatch[1].replace(/^["']|["']$/g, "");
            if (currentParent && typeof frontmatter[currentParent] === "object" && !Array.isArray(frontmatter[currentParent])) {
                const parent = frontmatter[currentParent];
                if (!Array.isArray(parent[currentKey])) {
                    parent[currentKey] = [];
                }
                parent[currentKey].push(value);
            }
            else {
                if (!Array.isArray(frontmatter[currentKey])) {
                    frontmatter[currentKey] = [];
                }
                frontmatter[currentKey].push(value);
            }
            continue;
        }
    }
    return { frontmatter, body: body.trim() };
}
function parseInlineArray(value) {
    const inner = value.replace(/^\[/, "").replace(/\].*$/, "");
    if (inner.trim() === "")
        return [];
    return inner
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter((s) => s !== "");
}
export function parsePrinciple(content, filePath) {
    const { frontmatter, body } = parseFrontmatter(content);
    const scope = frontmatter.scope || {};
    return {
        id: frontmatter.id || "",
        title: frontmatter.title || "",
        severity: frontmatter.severity || "convention",
        scope: {
            languages: scope.languages || [],
            layers: scope.layers || [],
            file_patterns: scope.file_patterns || [],
        },
        tags: frontmatter.tags || [],
        body,
        filePath,
    };
}
export async function loadPrincipleFile(filePath) {
    const content = await readFile(filePath, "utf-8");
    return parsePrinciple(content, filePath);
}
