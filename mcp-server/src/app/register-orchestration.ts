import { registerAgentTeamsTools } from "./register-agent-teams.ts";
import { registerCategorizeTool } from "./register-categorize.ts";
import { registerHistoryTools } from "./register-history.ts";
import { registerInitWorkspaceTool } from "./register-init-workspace.ts";
import { registerJanitorTool } from "./register-janitor.ts";
import { registerJournalTools } from "./register-journal.ts";
import { registerMessagingTools } from "./register-messaging.ts";
import { registerPresentArtifactTool } from "./register-present-artifact.ts";
import { registerReportTools } from "./register-report.ts";

export function registerOrchestrationTools(): void {
  registerInitWorkspaceTool();
  registerReportTools();
  registerMessagingTools();
  registerCategorizeTool();
  registerJournalTools();
  registerJanitorTool();
  registerAgentTeamsTools();
  registerHistoryTools();
  registerPresentArtifactTool();
}
