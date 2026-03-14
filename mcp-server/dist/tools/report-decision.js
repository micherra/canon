import { DriftStore } from "../drift/store.js";
import { randomBytes } from "crypto";
export async function reportDecision(input, projectDir) {
    const decisionId = `dec_${formatDate()}_${randomBytes(2).toString("hex")}`;
    const timestamp = new Date().toISOString();
    const entry = {
        decision_id: decisionId,
        timestamp,
        principle_id: input.principle_id,
        file_path: input.file_path,
        justification: input.justification,
        ...(input.category ? { category: input.category } : {}),
    };
    const store = new DriftStore(projectDir);
    await store.appendDecision(entry);
    return {
        recorded: true,
        decision_id: decisionId,
        note: "Deviation logged. This will be surfaced in drift reports.",
    };
}
function formatDate() {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, "0");
    const d = String(now.getDate()).padStart(2, "0");
    return `${y}${m}${d}`;
}
