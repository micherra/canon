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

export const LAYER_CENTRALITY: Record<string, number> = {
  shared: 3,
  domain: 2,
  data: 1.5,
  api: 1,
  infra: 1,
  ui: 0.5,
  unknown: 0,
};
