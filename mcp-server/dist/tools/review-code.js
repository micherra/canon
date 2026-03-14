import { matchPrinciples, loadAllPrinciples } from "../matcher.js";
export async function reviewCode(input, projectDir, pluginDir) {
    const allPrinciples = await loadAllPrinciples(projectDir, pluginDir);
    const matched = matchPrinciples(allPrinciples, {
        file_path: input.file_path,
    });
    // Return matched principles with full bodies for the calling agent to evaluate.
    // This tool is a data provider — the actual review (determining violations vs.
    // compliance) is performed by the LLM agent, not programmatically.
    const principlesToEvaluate = matched.map((p) => ({
        principle_id: p.id,
        principle_title: p.title,
        severity: p.severity,
        body: p.body,
    }));
    const ruleCount = matched.filter((p) => p.severity === "rule").length;
    const opinionCount = matched.filter((p) => p.severity === "strong-opinion").length;
    const conventionCount = matched.filter((p) => p.severity === "convention").length;
    const summary = `${matched.length} principle(s) matched for review (${ruleCount} rules, ${opinionCount} strong-opinions, ${conventionCount} conventions). Evaluate each against the code below.`;
    return {
        summary,
        principles_to_evaluate: principlesToEvaluate,
        code: input.code,
        file_path: input.file_path,
        context: input.context,
    };
}
