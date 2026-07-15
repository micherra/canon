import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAgentTeamsTools } from "./register-agent-teams.ts";
import { registerCategorizeTool } from "./register-categorize.ts";
import { registerCompileWavesTool } from "./register-compile-waves.ts";
import { registerConfidenceTools } from "./register-confidence-tools.ts";
import { registerEvaluateStepTool } from "./register-evaluate-step.ts";
import { registerHistoryTools } from "./register-history.ts";
import { registerInitWorkspaceTool } from "./register-init-workspace.ts";
import { registerJanitorTool } from "./register-janitor.ts";
import { registerJournalTools } from "./register-journal.ts";
import { registerMessagingTools } from "./register-messaging.ts";
import { registerOpenArtifactTool } from "./register-open-artifact.ts";
import { registerReportTools } from "./register-report.ts";

export function registerOrchestrationTools(server: McpServer): void {
  registerInitWorkspaceTool(server);
  registerReportTools(server);
  registerMessagingTools(server);
  registerCategorizeTool(server);
  registerJournalTools(server);
  registerJanitorTool(server);
  registerAgentTeamsTools(server);
  registerHistoryTools(server);
  registerOpenArtifactTool(server);
  registerConfidenceTools(server);
  registerEvaluateStepTool(server);
  registerCompileWavesTool(server);
}
