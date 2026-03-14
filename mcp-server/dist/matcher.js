import { readdir } from "fs/promises";
import { join } from "path";
import { loadPrincipleFile } from "./parser.js";
const EXTENSION_TO_LANGUAGE = {
    ".ts": "typescript",
    ".tsx": "typescript",
    ".js": "javascript",
    ".jsx": "javascript",
    ".py": "python",
    ".java": "java",
    ".go": "go",
    ".rs": "rust",
    ".rb": "ruby",
    ".tf": "terraform",
};
const PATH_TO_LAYER = [
    [/\/(api|routes|controllers)\//, "api"],
    [/\/(components|pages|views)\//, "ui"],
    [/\/(services|domain|models)\//, "domain"],
    [/\/(db|data|repositories|prisma)\//, "data"],
    [/\/(infra|deploy|terraform|docker)\//, "infra"],
    [/\/(utils|lib|shared|types)\//, "shared"],
];
const SEVERITY_RANK = {
    rule: 1,
    "strong-opinion": 2,
    convention: 3,
};
export function inferLanguage(filePath) {
    const ext = filePath.match(/\.\w+$/)?.[0];
    return ext ? EXTENSION_TO_LANGUAGE[ext] : undefined;
}
export function inferLayer(filePath) {
    for (const [pattern, layer] of PATH_TO_LAYER) {
        if (pattern.test(filePath))
            return layer;
    }
    return undefined;
}
function globToRegex(pattern) {
    const regex = pattern
        .replace(/\./g, "\\.")
        .replace(/\*\*/g, "{{DOUBLESTAR}}")
        .replace(/\*/g, "[^/]*")
        .replace(/\{\{DOUBLESTAR\}\}/g, ".*");
    return new RegExp(`(^|/)${regex}$`);
}
function severityPassesFilter(severity, filter) {
    if (!filter)
        return true;
    return (SEVERITY_RANK[severity] ?? 9) <= (SEVERITY_RANK[filter] ?? 9);
}
export function matchPrinciples(principles, filters) {
    const language = filters.language || (filters.file_path ? inferLanguage(filters.file_path) : undefined);
    const layers = filters.layers || (filters.file_path ? [inferLayer(filters.file_path)].filter(Boolean) : []);
    return principles
        .filter((p) => {
        // Severity filter
        if (!severityPassesFilter(p.severity, filters.severity_filter))
            return false;
        // Language filter
        if (language && p.scope.languages.length > 0) {
            if (!p.scope.languages.includes(language))
                return false;
        }
        // Layer filter
        if (layers.length > 0 && p.scope.layers.length > 0) {
            if (!layers.some((l) => p.scope.layers.includes(l)))
                return false;
        }
        // File pattern filter
        if (filters.file_path && p.scope.file_patterns.length > 0) {
            const matched = p.scope.file_patterns.some((pattern) => {
                const regex = globToRegex(pattern);
                return regex.test(filters.file_path);
            });
            if (!matched)
                return false;
        }
        // Tag filter
        if (filters.tags && filters.tags.length > 0) {
            if (!filters.tags.some((t) => p.tags.includes(t)))
                return false;
        }
        return true;
    })
        .sort((a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9));
}
export async function loadPrinciplesFromDir(dir) {
    try {
        const files = await readdir(dir);
        const mdFiles = files.filter((f) => f.endsWith(".md"));
        const principles = await Promise.all(mdFiles.map((f) => loadPrincipleFile(join(dir, f))));
        return principles.filter((p) => p.id !== "");
    }
    catch {
        return [];
    }
}
export async function loadAllPrinciples(projectDir, pluginDir) {
    const projectPrinciples = await loadPrinciplesFromDir(join(projectDir, ".canon", "principles"));
    const pluginPrinciples = await loadPrinciplesFromDir(join(pluginDir, "principles"));
    // Project-local takes precedence on ID conflict
    const seenIds = new Set(projectPrinciples.map((p) => p.id));
    const merged = [
        ...projectPrinciples,
        ...pluginPrinciples.filter((p) => !seenIds.has(p.id)),
    ];
    return merged;
}
