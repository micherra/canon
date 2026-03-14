export interface DecisionEntry {
    decision_id: string;
    timestamp: string;
    principle_id: string;
    file_path: string;
    justification: string;
    category?: string;
}
export interface ReviewViolation {
    principle_id: string;
    severity: string;
}
export interface ReviewEntry {
    review_id: string;
    timestamp: string;
    verdict: "BLOCKING" | "WARNING" | "CLEAN";
    files: string[];
    violations: ReviewViolation[];
    honored: string[];
    score: {
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
    };
}
export declare class DriftStore {
    private decisionsPath;
    private reviewsPath;
    constructor(projectDir: string);
    getDecisions(): Promise<DecisionEntry[]>;
    getReviews(): Promise<ReviewEntry[]>;
    appendDecision(entry: DecisionEntry): Promise<void>;
    appendReview(entry: ReviewEntry): Promise<void>;
}
