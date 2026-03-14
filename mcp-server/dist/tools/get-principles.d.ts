export interface GetPrinciplesInput {
    file_path?: string;
    language?: string;
    layers?: string[];
    task_description?: string;
}
export interface GetPrinciplesOutput {
    principles: Array<{
        id: string;
        title: string;
        severity: string;
        body: string;
    }>;
    total_matched: number;
    total_in_canon: number;
}
export declare function getPrinciples(input: GetPrinciplesInput, projectDir: string, pluginDir: string): Promise<GetPrinciplesOutput>;
