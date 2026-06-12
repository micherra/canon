/**
 * present_artifact MCP tool — thin wrapper.
 *
 * The reusable `presentArtifact` function and its types live in
 * `@app/artifact-presentation.ts` (composition root). This file re-exports
 * them so existing importers via this path continue to resolve, and exposes
 * the tool handler used by `register-present-artifact.ts`.
 *
 * See `@app/artifact-presentation.ts` for the full implementation.
 */

export type {
  PresentArtifactInput,
  PresentArtifactResult,
} from "@app/artifact-presentation.ts";
export { presentArtifact } from "@app/artifact-presentation.ts";
