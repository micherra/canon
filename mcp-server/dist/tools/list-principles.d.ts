export interface ListPrinciplesInput {
    filter_severity?: "rule" | "strong-opinion" | "convention";
    filter_tags?: string[];
    filter_layers?: string[];
}
export interface ListPrinciplesOutput {
    principles: Array<{
        id: string;
        title: string;
        severity: string;
        tags: string[];
        scope: {
            languages: string[];
            layers: string[];
        };
    }>;
    total: number;
}
export declare function listPrinciples(input: ListPrinciplesInput, projectDir: string, pluginDir: string): Promise<ListPrinciplesOutput>;
