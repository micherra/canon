#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { getJobManager } from "@platform/jobs/job-manager.ts";
import { registerArtifactTools } from "./register-artifacts.ts";
import { registerCompositeTools } from "./register-composite.ts";
import { registerKnowledgeTools } from "./register-knowledge.ts";
import { registerOrchestrationTools } from "./register-orchestration.ts";
import { registerPrincipleTools } from "./register-principles.ts";
import { resolveProjectDir } from "./resolve-project-dir.ts";
import { resolveReady, server, setProjectDir } from "./server-state.ts";

// Register all tool categories
registerOrchestrationTools();
registerKnowledgeTools();
registerArtifactTools();
registerPrincipleTools();
registerCompositeTools();

// --- Signal handlers for child process cleanup ---

function cleanupAndExit(signal: string): void {
  try {
    const manager = getJobManager();
    if (manager) manager.cleanup();
  } catch {
    // Best-effort cleanup — do not let errors prevent shutdown
  }
  process.exit(signal === "SIGTERM" ? 0 : 1);
}

process.on("SIGTERM", () => cleanupAndExit("SIGTERM"));
process.on("SIGINT", () => cleanupAndExit("SIGINT"));

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Resolve project dir via priority chain (must happen after connect so roots/list works).
  // resolveReady() unblocks every gatedWrapHandler that is awaiting readyPromise.
  const resolvedDir = await resolveProjectDir(
    process.env.CANON_PROJECT_DIR,
    () => server.server.listRoots(undefined, { timeout: 1_000 }),
    process.cwd(),
  );
  setProjectDir(resolvedDir);
  resolveReady();

  // Mark any leftover running jobs from a previous crashed session as failed
  try {
    const manager = getJobManager();
    if (manager) manager.cleanup();
  } catch {
    // Best-effort — do not fail startup if cleanup errors
  }
}

main().catch((error) => {
  console.error("Canon MCP server error:", error);
  process.exit(1);
});
