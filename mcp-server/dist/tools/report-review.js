import { DriftStore } from "../drift/store.js";
import { randomBytes } from "crypto";
export async function reportReview(input, projectDir) {
    const reviewId = `rev_${formatDate()}_${randomBytes(2).toString("hex")}`;
    const timestamp = new Date().toISOString();
    const verdict = input.verdict ?? deriveVerdict(input);
    const entry = {
        review_id: reviewId,
        timestamp,
        verdict,
        files: input.files,
        violations: input.violations,
        honored: input.honored,
        score: input.score,
    };
    const store = new DriftStore(projectDir);
    await store.appendReview(entry);
    return {
        recorded: true,
        review_id: reviewId,
        note: "Review logged. Results will appear in drift reports and inform learning suggestions.",
    };
}
function deriveVerdict(input) {
    const hasRuleViolation = input.violations.some((v) => v.severity === "rule");
    if (hasRuleViolation)
        return "BLOCKING";
    const hasOpinionViolation = input.violations.some((v) => v.severity === "strong-opinion");
    if (hasOpinionViolation)
        return "WARNING";
    return "CLEAN";
}
function formatDate() {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, "0");
    const d = String(now.getDate()).padStart(2, "0");
    return `${y}${m}${d}`;
}
