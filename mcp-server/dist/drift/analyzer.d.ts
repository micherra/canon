import { type DecisionEntry, type ReviewEntry } from "./store.js";
export interface PrincipleStats {
    principle_id: string;
    total_violations: number;
    unintentional_violations: number;
    intentional_deviations: number;
    times_honored: number;
    compliance_rate: number;
}
export interface DirectoryStats {
    directory: string;
    total_violations: number;
    review_count: number;
}
export interface DriftReport {
    total_reviews: number;
    total_decisions: number;
    avg_score: {
        rules: number;
        opinions: number;
        conventions: number;
    };
    most_violated: PrincipleStats[];
    hotspot_directories: DirectoryStats[];
    intentional_ratio: number;
    recent_decisions: DecisionEntry[];
    never_triggered: string[];
    trend: "improving" | "stable" | "declining" | "insufficient_data";
}
export declare function analyzeDrift(reviews: ReviewEntry[], decisions: DecisionEntry[], allPrincipleIds: string[], options?: {
    lastN?: number;
    principleId?: string;
    directory?: string;
}): DriftReport;
