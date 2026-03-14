export interface ReportDecisionInput {
    principle_id: string;
    file_path: string;
    justification: string;
    category?: string;
}
export interface ReportDecisionOutput {
    recorded: boolean;
    decision_id: string;
    note: string;
}
export declare function reportDecision(input: ReportDecisionInput, projectDir: string): Promise<ReportDecisionOutput>;
