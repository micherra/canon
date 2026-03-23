export const LAYER_COLORS: Record<string, string> = {
  api: "#4A90D9",
  ui: "#50C878",
  domain: "#9B59B6",
  data: "#E67E22",
  infra: "#7F8C8D",
  shared: "#1ABC9C",
  unknown: "#BDC3C7",
};

export const VERDICT_COLORS: Record<string, string> = {
  CLEAN: "#27ae60",
  WARNING: "#f39c12",
  BLOCKING: "#e74c3c",
};

export const SEVERITY_COLORS: Record<string, string> = {
  rule: "#e74c3c",
  "strong-opinion": "#f39c12",
  convention: "#3498db",
};

export const NODE_DEFAULT = "#6b7394";
export const NODE_CHANGED = "#6c8cff";

export function getLayerColor(layer: string): string {
  return LAYER_COLORS[layer] || LAYER_COLORS.unknown;
}

export function truncate(text: string, maxLen: number): string {
  return text.length > maxLen ? text.slice(0, maxLen) + "..." : text;
}

/** Built-in structural rule descriptions. */
export const BUILTIN_RULE_DESCRIPTIONS: Record<string, string> = {
  "imports-across-layers": "A file imports directly from a layer it should not depend on, violating the project's layered architecture boundaries.",
};

/**
 * Get a human-readable tooltip for a violation rule ID.
 * Checks built-in rules first, then the principles map from the MCP server.
 */
export function getRuleDescription(
  ruleId: string,
  principles?: Record<string, { title: string; summary: string }>,
): string {
  if (BUILTIN_RULE_DESCRIPTIONS[ruleId]) return BUILTIN_RULE_DESCRIPTIONS[ruleId];
  const p = principles?.[ruleId];
  if (p) return `${p.title}\n\n${p.summary}`;
  return ruleId;
}

export const LAYER_CENTRALITY: Record<string, number> = {
  shared: 3,
  domain: 2,
  data: 1.5,
  api: 1,
  infra: 1,
  ui: 0.5,
  unknown: 0,
};
