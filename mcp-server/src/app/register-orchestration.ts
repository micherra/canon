import { registerAgentTeamsTools } from "./register-agent-teams.ts";
import { registerCategorizeTool } from "./register-categorize.ts";
import { registerDriveFlowTool } from "./register-drive-flow.ts";
import { registerFlowCoreTools } from "./register-flow-core.ts";
import { registerHistoryTools } from "./register-history.ts";
import { registerInitWorkspaceTool } from "./register-init-workspace.ts";
import { registerJanitorTool } from "./register-janitor.ts";
import { registerJournalTools } from "./register-journal.ts";
import { registerMessagingTools } from "./register-messaging.ts";
import { registerReportTools } from "./register-report.ts";
import { registerUpdateBoardTool } from "./register-update-board.ts";
import { registerWaveEventTools } from "./register-wave-events.ts";

export function registerOrchestrationTools(): void {
  registerFlowCoreTools();
  registerInitWorkspaceTool();
  registerReportTools();
  registerUpdateBoardTool();
  registerWaveEventTools();
  registerMessagingTools();
  registerDriveFlowTool();
  registerCategorizeTool();
  registerJournalTools();
  registerJanitorTool();
  registerAgentTeamsTools();
  registerHistoryTools();
}
