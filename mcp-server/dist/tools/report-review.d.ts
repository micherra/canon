export interface ReviewViolationInput {
    principle_id: string;
    severity: string;
}
export interface ReviewScoreInput {
    rules: {
        passed: number;
        total: number;
    };
    opinions: {
        passed: number;
        total: number;
    };
    conventions: {
        passed: number;
        total: number;
    };
}
export interface ReportReviewInput {
    files: string[];
    violations: ReviewViolationInput[];
    honored: string[];
    score: ReviewScoreInput;
    verdict?: "BLOCKING" | "WARNING" | "CLEAN";
}
export interface ReportReviewOutput {
    recorded: boolean;
    review_id: string;
    note: string;
}
export declare function reportReview(input: ReportReviewInput, projectDir: string): Promise<ReportReviewOutput>;
