import { presentArtifact } from "@features/orchestration/tools/present-artifact.ts";
import { z } from "zod";
import { gatedWrapHandler, server } from "./server-state.ts";

export function registerPresentArtifactTool(): void {
  server.registerTool(
    "present_artifact",
    {
      description:
        "Serve an interactive HTML artifact via the Canon HTTP server and block until the user approves or requests changes in the browser. Opens the artifact URL in the default browser. Returns the user's decision and the URL.",
      inputSchema: {
        data: z
          .record(z.string(), z.unknown())
          .describe(
            "Arbitrary data payload serialized as window.__CANON_DATA__ in the browser view",
          ),
        slug: z.string().describe("Unique identifier for this artifact instance"),
        type: z.string().describe('Artifact view type. Supported values: "planning-brief"'),
        workspace: z.string().describe("Workspace directory path"),
      },
    },
    gatedWrapHandler(async (input) =>
      presentArtifact({
        data: input.data,
        slug: input.slug,
        type: input.type,
        workspace: input.workspace,
      }),
    ),
  );
}
