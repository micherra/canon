/**
 * Spike Eval — Scope Fix Experiment
 *
 * Tests whether making Group B principles universal (scope.layers: [])
 * improves recall@10 when using the matchPrinciples() matcher directly.
 *
 * This eval uses the actual production matching logic rather than semantic embeddings:
 * - loadAllPrinciples() to load all principles from the worktree
 * - matchPrinciples() with { file_path } to filter applicable principles
 * - The top-10 returned principles are checked against ground truth
 *
 * Key question: does scope.layers: [] (universal) cause Group B principles
 * to appear in the top-10 results for all 13 ground truth files?
 *
 * Usage:
 *   cd mcp-server && npx tsx ../.spike/spike-eval-scope-fix.ts
 */

import { join } from "node:path";
import { loadAllPrinciples, matchPrinciples, inferLayer } from "../mcp-server/src/shared/matcher.ts";

// ---------------------------------------------------------------------------
// Resolve paths
// ---------------------------------------------------------------------------

import { fileURLToPath } from "node:url";
const SPIKE_DIR =
  typeof __dirname !== "undefined"
    ? __dirname
    : fileURLToPath(new URL(".", import.meta.url));
const WORKTREE = join(SPIKE_DIR, ".."); // .spike/../ = worktree root

// ---------------------------------------------------------------------------
// Ground truth — same as all prior iterations
// ---------------------------------------------------------------------------

const GROUND_TRUTH: Record<string, string[]> = {
  "graph/kg-embedding.ts": [
    "errors-are-values",
    "observable-best-effort",
    "simplicity-first",
    "handle-partial-failure",
  ],
  "graph/kg-store.ts": [
    "information-hiding",
    "prefer-immutable-data",
    "simplicity-first",
    "consistent-abstraction-levels",
  ],
  "graph/kg-pipeline.ts": [
    "errors-are-values",
    "handle-partial-failure",
    "observable-best-effort",
    "functions-do-one-thing",
  ],
  "graph/kg-query.ts": [
    "information-hiding",
    "command-query-separation",
    "consistent-abstraction-levels",
    "measure-before-optimizing",
  ],
  "graph/kg-vector-store.ts": [
    "information-hiding",
    "wrap-external-exceptions",
    "simplicity-first",
    "errors-are-values",
  ],
  "features/orchestration/tools/drive-flow.ts": [
    "errors-are-values",
    "no-hidden-side-effects",
    "functions-do-one-thing",
    "handle-partial-failure",
    "validate-at-trust-boundaries",
  ],
  "features/orchestration/tools/report-result.ts": [
    "errors-are-values",
    "no-hidden-side-effects",
    "command-query-separation",
    "fail-closed-by-default",
  ],
  "features/orchestration/tools/init-workspace.ts": [
    "validate-at-trust-boundaries",
    "errors-are-values",
    "fail-closed-by-default",
    "no-hidden-side-effects",
    "least-privilege-access",
  ],
  "features/principles/tools/get-principles.ts": [
    "validate-at-trust-boundaries",
    "information-hiding",
    "errors-are-values",
    "functions-do-one-thing",
  ],
  "features/file-context/tools/get-file-context.ts": [
    "validate-at-trust-boundaries",
    "errors-are-values",
    "information-hiding",
    "handle-partial-failure",
    "least-privilege-access",
  ],
  "shared/matcher.ts": [
    "measure-before-optimizing",
    "information-hiding",
    "functions-do-one-thing",
    "consistent-abstraction-levels",
  ],
  "shared/parser.ts": [
    "functions-do-one-thing",
    "errors-are-values",
    "consistent-abstraction-levels",
    "define-errors-out-of-existence",
  ],
  "shared/lib/tool-result.ts": [
    "errors-are-values",
    "information-hiding",
    "consistent-abstraction-levels",
    "fail-closed-by-default",
  ],
};

// ---------------------------------------------------------------------------
// Recall@K metric
// ---------------------------------------------------------------------------

function recall_at_k(
  rankedIds: string[],
  groundTruth: string[],
  k: number,
): number {
  if (groundTruth.length === 0) return 1.0;
  const topK = new Set(rankedIds.slice(0, k));
  const hits = groundTruth.filter((id) => topK.has(id)).length;
  return hits / groundTruth.length;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("=== Spike Eval: Scope Fix (scope.layers: [] -> universal) ===\n");
  console.log("Worktree:", WORKTREE);

  // loadAllPrinciples(projectDir, pluginDir)
  // - projectDir: worktree root — looks at {projectDir}/.canon/principles/ (local overrides)
  // - pluginDir: worktree root — looks at {pluginDir}/principles/ (built-in principles)
  console.log("Loading all principles...");
  const principles = await loadAllPrinciples(WORKTREE, WORKTREE);
  console.log(`Loaded ${principles.length} principles\n`);

  // Severity breakdown
  const bySeverity: Record<string, number> = {};
  for (const p of principles) {
    bySeverity[p.severity] = (bySeverity[p.severity] || 0) + 1;
  }
  console.log("Severity breakdown:", JSON.stringify(bySeverity));

  // Universal vs scoped after our changes
  const universal = principles.filter((p) => p.scope.layers.length === 0);
  const scoped = principles.filter((p) => p.scope.layers.length > 0);
  console.log(`Universal (scope.layers: []): ${universal.length}`);
  console.log(`Scoped (have layer constraints): ${scoped.length}`);
  if (scoped.length > 0) {
    console.log(`  Scoped IDs: ${scoped.map((p) => `${p.id}[${p.scope.layers.join(",")}]`).join(", ")}`);
  }
  console.log();

  // For each ground truth file, call matchPrinciples and compute recall@10
  const results: Array<{
    file: string;
    matchedIds: string[];
    groundTruth: string[];
    recall10: number;
    hits: string[];
    misses: string[];
    inferredLayer: string | undefined;
  }> = [];

  for (const [filePath, gt] of Object.entries(GROUND_TRUTH)) {
    const matched = matchPrinciples(principles, { file_path: filePath });
    const matchedIds = matched.map((p) => p.id);
    const r10 = recall_at_k(matchedIds, gt, 10);
    const top10 = new Set(matchedIds.slice(0, 10));
    const hits = gt.filter((id) => top10.has(id));
    const misses = gt.filter((id) => !top10.has(id));
    const inferredLayer = inferLayer(filePath);

    results.push({ file: filePath, matchedIds, groundTruth: gt, recall10: r10, hits, misses, inferredLayer });
  }

  // Aggregate recall@10
  const aggRecall10 = results.reduce((s, r) => s + r.recall10, 0) / results.length;

  console.log("=== RESULTS ===\n");
  console.log(`Aggregate Recall@10: ${(aggRecall10 * 100).toFixed(1)}%`);
  console.log(`Go threshold: >=80% -> ${aggRecall10 >= 0.8 ? "GO" : "NO-GO"}\n`);

  for (const r of results) {
    console.log(`${r.file}`);
    console.log(`  Layer inferred: ${r.inferredLayer ?? "(none)"}`);
    console.log(`  Principles matched: ${r.matchedIds.length}`);
    console.log(`  Recall@10: ${(r.recall10 * 100).toFixed(0)}%`);
    console.log(`  Hits (in top-10): ${r.hits.join(", ") || "(none)"}`);
    console.log(`  Misses (not in top-10): ${r.misses.join(", ") || "(none)"}`);
    console.log(`  Top-10 IDs: ${r.matchedIds.slice(0, 10).join(", ")}`);
    console.log();
  }

  // Analysis
  const ruleCount = principles.filter((p) => p.severity === "rule").length;
  const soSlots = 10 - ruleCount;
  const soIds = principles.filter((p) => p.severity === "strong-opinion").map((p) => p.id);

  console.log("=== ANALYSIS ===\n");
  console.log(`Rules (always fill top-${ruleCount} slots): ${principles.filter((p) => p.severity === "rule").map((p) => p.id).join(", ")}`);
  console.log(`Strong-opinion slots in top-10: ${soSlots}`);
  console.log(`First ${soSlots} strong-opinions by load order: ${soIds.slice(0, soSlots).join(", ")}`);
  console.log();

  // Which GT strong-opinions are in the first soSlots?
  const allGtIds = new Set(Object.values(GROUND_TRUTH).flat());
  const gtSOs = [...allGtIds].filter((id) => {
    const p = principles.find((p) => p.id === id);
    return p && p.severity === "strong-opinion";
  });
  const gtSoHits = gtSOs.filter((id) => soIds.indexOf(id) < soSlots);
  const gtSoMisses = gtSOs.filter((id) => soIds.indexOf(id) >= soSlots || soIds.indexOf(id) === -1);

  console.log(`GT strong-opinions in corpus (${gtSOs.length}): ${gtSOs.join(", ")}`);
  console.log(`  In first ${soSlots} SO slots (would hit): ${gtSoHits.join(", ") || "(none)"}`);
  console.log(`  Outside first ${soSlots} SO slots (would miss): ${gtSoMisses.join(", ") || "(none)"}`);
  console.log();

  const gtRules = [...allGtIds].filter((id) => {
    const p = principles.find((p) => p.id === id);
    return p && p.severity === "rule";
  });
  console.log(`GT rules (always hit): ${gtRules.join(", ") || "(none)"}`);
  console.log();

  console.log("CONCLUSION:");
  if (aggRecall10 >= 0.8) {
    console.log("  PASS — scope.layers: [] fix achieves >=80% recall@10.");
    console.log("  The scope fix alone is sufficient for the matcher to include GT principles.");
  } else {
    console.log("  FAIL — scope.layers: [] fix does NOT achieve >=80% recall@10.");
    console.log("  matchPrinciples() is a scope filter, not a semantic ranker.");
    console.log("  All universal principles appear in results, sorted by severity+load-order,");
    console.log("  not by relevance to the file. The top-10 is determined by which principles");
    console.log("  happen to be loaded first (readdir order), not by semantic match quality.");
    console.log("  Semantic matching (embeddings or LLM selection) is required for 80%+ recall.");
  }
}

main().catch((err) => {
  console.error("Spike eval failed:", err);
  process.exit(1);
});
