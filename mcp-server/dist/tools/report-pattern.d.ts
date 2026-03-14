export interface ReportPatternInput {
    pattern: string;
    file_paths: string[];
    context?: string;
}
export interface ReportPatternOutput {
    recorded: boolean;
    pattern_id: string;
    note: string;
}
export declare function reportPattern(input: ReportPatternInput, projectDir: string): Promise<ReportPatternOutput>;
