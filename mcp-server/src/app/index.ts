#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { gitExec } from "@platform/adapters/git-adapter.ts";
import { cleanupAllJobManagers } from "@platform/jobs/job-manager.ts";
import { startHttpServer } from "./http-server.ts";
import { registerArtifactTools } from "./register-artifacts.ts";
import { registerKnowledgeTools } from "./register-knowledge.ts";
import { registerOrchestrationTools } from "./register-orchestration.ts";
import { registerPrincipleTools } from "./register-principles.ts";
import { resolveGitRoot, resolveProjectDir } from "./resolve-project-dir.ts";
import { registerConnectionScope, resolveReady, STDIO_SESSION_ID, server } from "./server-state.ts";

// Register all tool categories
registerOrchestrationTools();
registerKnowledgeTools();
registerArtifactTools();
registerPrincipleTools();

// --- Signal handlers for child process cleanup ---

function cleanupAndExit(signal: string): void {
  try {
    cleanupAllJobManagers();
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
  //
  // For the cwd fallback: prefer the git repo root over the raw process.cwd() so that
  // runtime state (.canon/ dir) always lands at the repo root even when the MCP server
  // process starts with cwd set to a subdirectory (e.g. mcp-server/).
  const cwdFallback = resolveGitRoot(process.cwd(), gitExec);

  const resolvedDir = await resolveProjectDir(
    process.env.CANON_PROJECT_DIR,
    () => server.server.listRoots(undefined, { timeout: 1_000 }),
    cwdFallback,
  );
  registerConnectionScope(STDIO_SESSION_ID, resolvedDir);
  resolveReady();

  // Start the HTTP server for interactive HTML artifact serving.
  // Binds to 127.0.0.1 (localhost only). On EADDRINUSE, logs a warning
  // and continues — MCP server operates normally without HTTP artifacts.
  // Thread the resolved startup scope so resolvePidDir uses it instead of
  // an implicit process.cwd() (Phase 2 isolation-finish — removes the last
  // implicit-scope leak).
  await startHttpServer(undefined, resolvedDir);

  // Mark any leftover running jobs from a previous crashed session as failed
  try {
    cleanupAllJobManagers();
  } catch {
    // Best-effort — do not fail startup if cleanup errors
  }
}

main().catch((error) => {
  console.error("Canon MCP server error:", error);
  process.exit(1);
});
