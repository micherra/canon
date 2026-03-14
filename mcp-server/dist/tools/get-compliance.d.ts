export interface GetComplianceInput {
    principle_id: string;
}
export interface GetComplianceOutput {
    principle_id: string;
    found: boolean;
    compliance_rate: number;
    total_violations: number;
    unintentional_violations: number;
    intentional_deviations: number;
    times_honored: number;
    total_reviews: number;
    trend: "improving" | "stable" | "declining" | "insufficient_data";
}
export declare function getCompliance(input: GetComplianceInput, projectDir: string, pluginDir: string): Promise<GetComplianceOutput>;
