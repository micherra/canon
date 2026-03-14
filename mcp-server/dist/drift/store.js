import { readFile, appendFile, mkdir } from "fs/promises";
import { join } from "path";
async function readJsonl(filePath) {
    let content;
    try {
        content = await readFile(filePath, "utf-8");
    }
    catch {
        return [];
    }
    const results = [];
    const lines = content.split("\n");
    let skipped = 0;
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim() === "")
            continue;
        try {
            results.push(JSON.parse(lines[i]));
        }
        catch {
            skipped++;
        }
    }
    if (skipped > 0) {
        console.error(`[canon] Warning: skipped ${skipped} malformed line(s) in ${filePath}`);
    }
    return results;
}
async function appendJsonl(filePath, entry) {
    const dir = filePath.substring(0, filePath.lastIndexOf("/"));
    await mkdir(dir, { recursive: true });
    await appendFile(filePath, JSON.stringify(entry) + "\n", "utf-8");
}
export class DriftStore {
    decisionsPath;
    reviewsPath;
    constructor(projectDir) {
        this.decisionsPath = join(projectDir, ".canon", "decisions.jsonl");
        this.reviewsPath = join(projectDir, ".canon", "reviews.jsonl");
    }
    async getDecisions() {
        return readJsonl(this.decisionsPath);
    }
    async getReviews() {
        return readJsonl(this.reviewsPath);
    }
    async appendDecision(entry) {
        await appendJsonl(this.decisionsPath, entry);
    }
    async appendReview(entry) {
        await appendJsonl(this.reviewsPath, entry);
    }
}
