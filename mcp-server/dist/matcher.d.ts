import { type Principle } from "./parser.js";
export interface MatchFilters {
    language?: string;
    layers?: string[];
    file_path?: string;
    severity_filter?: "rule" | "strong-opinion" | "convention";
    tags?: string[];
}
export declare function inferLanguage(filePath: string): string | undefined;
export declare function inferLayer(filePath: string): string | undefined;
export declare function matchPrinciples(principles: Principle[], filters: MatchFilters): Principle[];
export declare function loadPrinciplesFromDir(dir: string): Promise<Principle[]>;
export declare function loadAllPrinciples(projectDir: string, pluginDir: string): Promise<Principle[]>;
