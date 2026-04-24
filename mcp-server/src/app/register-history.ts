import { getBuildHistory, GetBuildHistoryInputSchema } from "@features/history/tools/get-build-history.ts";
import { getCrossRunAnalysis, GetCrossRunAnalysisInputSchema } from "@features/history/tools/get-cross-run-analysis.ts";
import { getHistoricalArtifacts, GetHistoricalArtifactsInputSchema } from "@features/history/tools/get-historical-artifacts.ts";
import { gatedWrapHandler, server } from "./server-state.ts";

/**
 * Register history MCP tools: get_build_history, get_historical_artifacts,
 * and get_cross_run_analysis.
 */
export function registerHistoryTools(): void {
  server.registerTool(
    "get_build_history",
    {
      description: "List archived build runs with metadata.",
      inputSchema: GetBuildHistoryInputSchema.shape,
    },
    gatedWrapHandler(async (input) => getBuildHistory(input)),
  );

  server.registerTool(
    "get_historical_artifacts",
    {
      description: "Retrieve archived artifacts from a previous build.",
      inputSchema: GetHistoricalArtifactsInputSchema.shape,
    },
    gatedWrapHandler(async (input) => getHistoricalArtifacts(input)),
  );

  server.registerTool(
    "get_cross_run_analysis",
    {
      description: "Cross-run meta-analysis for the learner agent.",
      inputSchema: GetCrossRunAnalysisInputSchema.shape,
    },
    gatedWrapHandler(async (input) => getCrossRunAnalysis(input)),
  );
}
