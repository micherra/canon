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
          .record(z.string(), z.any())
          .describe(
            "Arbitrary JSON object serialized as window.__CANON_DATA__ in the browser view. Use an empty object {} when no data payload is needed.",
          ),
        html: z
          .string()
          .min(1, "html must be a non-empty HTML string when provided")
          .optional()
          .describe(
            "Complete HTML string to serve directly. Required — the 'type' field is used only as the artifact key prefix.",
          ),
        slug: z
          .string()
          .min(1, "slug must not be empty")
          .describe("Unique identifier for this artifact instance (e.g., the build slug)"),
        type: z
          .string()
          .min(1, "type must not be empty")
          .describe(
            'Artifact view type — used as the artifact key prefix (e.g., "design", "review").',
          ),
        workspace: z
          .string()
          .min(1, "workspace must not be empty")
          .describe("Absolute path to the Canon workspace directory"),
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
