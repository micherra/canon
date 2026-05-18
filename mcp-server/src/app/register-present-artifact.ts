import { presentArtifact } from "@features/orchestration/tools/present-artifact.ts";
import { z } from "zod";
import { gatedWrapHandler, server } from "./server-state.ts";

export function registerPresentArtifactTool(): void {
  server.registerTool(
    "present_artifact",
    {
      description:
        "Serve an interactive HTML artifact via the Canon HTTP server and open it in the default browser. Returns immediately with the artifact URL — the actual approve/reject decision happens in the terminal.",
      inputSchema: {
        data: z
          .unknown()
          .describe(
            "Arbitrary data payload serialized as window.__CANON_DATA__ in the browser view",
          ),
        html: z
          .string()
          .optional()
          .describe(
            "Complete HTML string to serve directly. When provided, bypasses VIEW_MAP lookup — the 'type' field is used only as the artifact key prefix.",
          ),
        slug: z.string().describe("Unique identifier for this artifact instance"),
        type: z
          .string()
          .describe(
            'Artifact view type — used as the artifact key prefix (e.g., "design", "review"). When html is provided, bypasses VIEW_MAP lookup.',
          ),
        workspace: z.string().describe("Workspace directory path"),
      },
    },
    gatedWrapHandler(async (input) =>
      presentArtifact({
        data: input.data,
        html: input.html,
        slug: input.slug,
        type: input.type,
        workspace: input.workspace,
      }),
    ),
  );
}
