import {
  loadAllOverlays,
  filterOverlaysForAgent,
  type OverlayDefinition,
} from "../orchestration/overlays.js";

export interface ListOverlaysInput {
  agent?: string;
}

export interface ListOverlaysResult {
  overlays: Array<{
    name: string;
    description: string;
    applies_to: string[];
    priority: number;
  }>;
  count: number;
}

export async function listOverlays(
  input: ListOverlaysInput,
  projectDir: string,
): Promise<ListOverlaysResult> {
  let overlays: OverlayDefinition[] = await loadAllOverlays(projectDir);

  if (input.agent) {
    overlays = filterOverlaysForAgent(overlays, input.agent);
  }

  return {
    overlays: overlays.map((o) => ({
      name: o.name,
      description: o.description,
      applies_to: o.applies_to,
      priority: o.priority,
    })),
    count: overlays.length,
  };
}
