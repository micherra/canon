import { matchPrinciples, loadAllPrinciples } from "../matcher.js";
export async function listPrinciples(input, projectDir, pluginDir) {
    const allPrinciples = await loadAllPrinciples(projectDir, pluginDir);
    const matched = matchPrinciples(allPrinciples, {
        severity_filter: input.filter_severity,
        tags: input.filter_tags,
        layers: input.filter_layers,
    });
    return {
        principles: matched.map((p) => ({
            id: p.id,
            title: p.title,
            severity: p.severity,
            tags: p.tags,
            scope: {
                languages: p.scope.languages,
                layers: p.scope.layers,
            },
        })),
        total: matched.length,
    };
}
