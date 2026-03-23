/**
 * Role overlays — swappable expertise lenses injected into agent spawn prompts.
 *
 * Overlays are stored as markdown files with YAML frontmatter in
 * `.canon/overlays/`. Each overlay declares which agents it applies to
 * and a priority for ordering.
 */

import { readdir, readFile } from "fs/promises";
import { join } from "path";
import { parse as parseYaml } from "yaml";

export interface OverlayDefinition {
  name: string;
  description: string;
  applies_to: string[];
  priority: number;
  body: string; // markdown body after frontmatter
}

// ---------------------------------------------------------------------------
// parseOverlay
// ---------------------------------------------------------------------------

/**
 * Parse overlay frontmatter and body from file content.
 */
export function parseOverlay(content: string): OverlayDefinition {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!fmMatch) {
    return {
      name: "",
      description: "",
      applies_to: [],
      priority: 500,
      body: content.trim(),
    };
  }

  const frontmatter = (parseYaml(fmMatch[1]) ?? {}) as Record<string, unknown>;
  const body = (fmMatch[2] ?? "").trim();

  return {
    name: (frontmatter.name as string) ?? "",
    description: (frontmatter.description as string) ?? "",
    applies_to: Array.isArray(frontmatter.applies_to)
      ? (frontmatter.applies_to as string[])
      : [],
    priority:
      typeof frontmatter.priority === "number" ? frontmatter.priority : 500,
    body,
  };
}

// ---------------------------------------------------------------------------
// loadOverlay
// ---------------------------------------------------------------------------

/**
 * Load a single overlay by name from the overlays directory.
 */
export async function loadOverlay(
  projectDir: string,
  name: string,
): Promise<OverlayDefinition> {
  const filePath = join(projectDir, ".canon", "overlays", `${name}.md`);
  const content = await readFile(filePath, "utf-8");
  return parseOverlay(content);
}

// ---------------------------------------------------------------------------
// loadAllOverlays
// ---------------------------------------------------------------------------

/**
 * Load all overlays from .canon/overlays/.
 */
export async function loadAllOverlays(
  projectDir: string,
): Promise<OverlayDefinition[]> {
  const overlaysDir = join(projectDir, ".canon", "overlays");

  let entries: string[];
  try {
    entries = await readdir(overlaysDir);
  } catch {
    return [];
  }

  const mdFiles = entries.filter((e) => e.endsWith(".md"));
  const overlays = await Promise.all(
    mdFiles.map(async (file) => {
      const content = await readFile(join(overlaysDir, file), "utf-8");
      return parseOverlay(content);
    }),
  );

  return overlays;
}

// ---------------------------------------------------------------------------
// filterOverlaysForAgent
// ---------------------------------------------------------------------------

/**
 * Filter overlays to those applicable to a specific agent.
 * Overlays with an empty applies_to array are treated as wildcards (apply to all agents).
 */
export function filterOverlaysForAgent(
  overlays: OverlayDefinition[],
  agent: string,
): OverlayDefinition[] {
  return overlays
    .filter((o) => o.applies_to.length === 0 || o.applies_to.includes(agent))
    .sort((a, b) => b.priority - a.priority); // higher priority first
}

// ---------------------------------------------------------------------------
// buildOverlayInjection
// ---------------------------------------------------------------------------

/**
 * Build the injection text for overlays (to be appended to spawn prompts).
 */
export function buildOverlayInjection(overlays: OverlayDefinition[]): string {
  if (overlays.length === 0) return "";
  const sections = overlays.map((o) => `## Role Overlay: ${o.name}\n\n${o.body}`);
  return `\n\n# Applied Role Overlays\n\n${sections.join("\n\n")}`;
}
