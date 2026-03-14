export interface ReviewCodeInput {
    code: string;
    file_path: string;
    context?: string;
}
export interface PrincipleForReview {
    principle_id: string;
    principle_title: string;
    severity: string;
    body: string;
}
export interface ReviewCodeOutput {
    summary: string;
    principles_to_evaluate: PrincipleForReview[];
    code: string;
    file_path: string;
    context?: string;
}
export declare function reviewCode(input: ReviewCodeInput, projectDir: string, pluginDir: string): Promise<ReviewCodeOutput>;
