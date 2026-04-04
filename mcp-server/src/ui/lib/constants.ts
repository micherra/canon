export const UNKNOWN_LAYER_COLOR = "#BDC3C7";

export const VERDICT_COLORS: Record<string, string> = {
  BLOCKING: "#e74c3c",
  CLEAN: "#27ae60",
  WARNING: "#f39c12",
};

export const SEVERITY_COLORS: Record<string, string> = {
  convention: "#3498db",
  rule: "#e74c3c",
  "strong-opinion": "#f39c12",
};

export const NODE_DEFAULT = "#c8cad4";
export const NODE_CHANGED = "#6c8cff";
export const NODE_VIOLATION = "#ff6b6b";

// ── Edge colors ────────────────────────────────────────────────────────────────
/** Default edge color — base visibility. */
export const EDGE_DEFAULT = "rgba(136, 153, 187, 0.2)";
/** Edge color when both endpoints are highlighted (PR, insight, search match). */
export const EDGE_HIGHLIGHTED = "rgba(136, 153, 187, 0.6)";
/** Edge color when one endpoint is highlighted. */
export const EDGE_SEMI_DIM = "rgba(136, 153, 187, 0.15)";
/** Edge color when neither endpoint matches — dimmed. */
export const EDGE_DIM = "rgba(136, 153, 187, 0.05)";
/** Edge color when very heavily dimmed (e.g. cascade non-members). */
export const EDGE_VERY_DIM = "rgba(136, 153, 187, 0.03)";
/** Edge color for edges adjacent to the focused node. */
export const EDGE_ADJACENT_FOCUS = "rgba(255, 255, 255, 0.3)";

// ── Node dim colors ────────────────────────────────────────────────────────────
/** Node color when unfocused (focus mode, cascade non-members). */
export const NODE_UNFOCUSED = "rgba(107, 115, 148, 0.07)";
/** Node color when dimmed by a filter (PR/insight/search non-match). */
export const NODE_DIM = "rgba(107, 115, 148, 0.2)";
/** Node color when highly dimmed (show-changed-only, node not changed). */
export const NODE_HIGHLY_DIM = "rgba(107, 115, 148, 0.13)";

function colorFromLayerName(layer: string): string {
  let hash = 0;
  for (let i = 0; i < layer.length; i++) {
    hash = (hash * 31 + layer.charCodeAt(i)) >>> 0;
  }
  const hue = hash % 360;
  return `hsl(${hue}, 62%, 56%)`;
}

export function getLayerColor(layer: string, layerColors?: Record<string, string>): string {
  if (layerColors?.[layer]) return layerColors[layer];
  if (layer === "unknown") return UNKNOWN_LAYER_COLOR;
  return colorFromLayerName(layer);
}

export function truncate(text: string, maxLen: number): string {
  return text.length > maxLen ? `${text.slice(0, maxLen)}...` : text;
}
