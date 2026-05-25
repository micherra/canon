import { openArtifact } from "@features/orchestration/tools/open-artifact.ts";
import { z } from "zod";
import { gatedWrapHandler, server } from "./server-state.ts";

/** Register the open_artifact MCP tool. */
export function registerOpenArtifactTool(): void {
  server.registerTool(
    "open_artifact",
    {
      description:
        "Open an HTML artifact from the workspace artifacts directory in the default browser. Reads the file and opens it via the Canon HTTP server. Returns immediately with the artifact URL.",
      inputSchema: {
        artifact_name: z
          .string()
          .min(1, "artifact_name must not be empty")
          .describe(
            'Name of the HTML artifact file to open (e.g. "review.html" or "review"). The .html extension is appended automatically when not provided.',
          ),
        workspace: z
          .string()
          .min(1, "workspace must not be empty")
          .describe("Absolute path to the Canon workspace directory"),
      },
    },
    gatedWrapHandler(async (input) => openArtifact(input)),
  );
}
