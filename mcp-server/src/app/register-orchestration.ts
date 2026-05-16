import { ResolvedFlowSchema } from "@domains/flows/flow-definition-schemas.ts";
import { resolveAfterConsultations } from "@features/orchestration/tools/resolve-after-consultations.ts";
import { z } from "zod";
import { registerAgentTeamsTools } from "./register-agent-teams.ts";
import { registerCategorizeTool } from "./register-categorize.ts";
import { registerHistoryTools } from "./register-history.ts";
import { registerInitWorkspaceTool } from "./register-init-workspace.ts";
import { registerJanitorTool } from "./register-janitor.ts";
import { registerJournalTools } from "./register-journal.ts";
import { registerMessagingTools } from "./register-messaging.ts";
import { registerPresentArtifactTool } from "./register-present-artifact.ts";
import { registerReportTools } from "./register-report.ts";
import { gatedWrapHandler, server } from "./server-state.ts";

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

  server.registerTool(
    "resolve_after_consultations",
    {
      description: "Resolve after-consultation prompts for a state.",
      inputSchema: {
        flow: ResolvedFlowSchema.describe("Resolved flow object"),
        state_id: z.string(),
        variables: z.record(z.string(), z.string()),
        workspace: z.string(),
      },
    },
    gatedWrapHandler(async (input) => resolveAfterConsultations(input)),
  );
}
