import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { installFuzzyValidation } from "@shared/lib/fuzzy-field-validation.ts";
import { registerArtifactTools } from "./register-artifacts.ts";
import { registerEvolutionTools } from "./register-evolution.ts";
import { registerKnowledgeTools } from "./register-knowledge.ts";
import { registerLearningTools } from "./register-learning.ts";
import { registerLoopTools } from "./register-loops.ts";
import { registerOrchestrationTools } from "./register-orchestration.ts";
import { registerPrincipleTools } from "./register-principles.ts";
import { registerRoutineTools } from "./register-routines.ts";

/** Canonical server name — matches the MCP server name used in client configs. */
export const CANON_SERVER_NAME = "canon";

/** Server version — keep the release-please marker on this line so version bumps work. */
export const CANON_SERVER_VERSION = "2.24.1"; // x-release-please-version

/**
 * Factory that creates a fully-wired Canon McpServer instance.
 *
 * Each call returns a distinct, independent McpServer — no shared state between
 * instances. This enables per-session server creation for the HTTP transport
 * (SDK 1.29 Protocol.connect() throws if already connected) while keeping the
 * stdio path behaviorally identical (one factory call in main()).
 *
 * Import direction: create-server.ts → register-*.ts → server-state.ts (helpers only).
 * server-state.ts must NOT import create-server.ts (no cycles).
 */
export function createCanonServer(): McpServer {
  const server = new McpServer({ name: CANON_SERVER_NAME, version: CANON_SERVER_VERSION });

  // Patch validation to detect unknown fields with fuzzy "did you mean?" suggestions.
  installFuzzyValidation(server);

  // Register all tool groups — 8 groups (learning added).
  registerOrchestrationTools(server);
  registerKnowledgeTools(server);
  registerArtifactTools(server);
  registerPrincipleTools(server);
  registerLoopTools(server);
  registerRoutineTools(server);
  registerEvolutionTools(server);
  registerLearningTools(server);

  return server;
}
