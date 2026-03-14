export interface PrincipleScope {
    languages: string[];
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
export declare function parseFrontmatter(content: string): {
    frontmatter: Record<string, unknown>;
    body: string;
};
export declare function parsePrinciple(content: string, filePath: string): Principle;
export declare function loadPrincipleFile(filePath: string): Promise<Principle>;
