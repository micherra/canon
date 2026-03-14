import { matchPrinciples, loadAllPrinciples } from "../matcher.js";
export async function getPrinciples(input, projectDir, pluginDir) {
    const allPrinciples = await loadAllPrinciples(projectDir, pluginDir);
    const matched = matchPrinciples(allPrinciples, {
        file_path: input.file_path,
        layers: input.layers,
    });
    // Limit to top 10, prioritized by severity (already sorted by matchPrinciples)
    const top = matched.slice(0, 10);
    return {
        principles: top.map((p) => ({
            id: p.id,
            title: p.title,
            severity: p.severity,
            body: p.body,
        })),
        total_matched: matched.length,
        total_in_canon: allPrinciples.length,
    };
}
