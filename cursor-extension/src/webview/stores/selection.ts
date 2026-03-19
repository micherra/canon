import { writable } from "svelte/store";
import type { GraphNode } from "./graphData";

export type PanelMode = "overview" | "focus";

export const selectedNode = writable<GraphNode | null>(null);
export const panelMode = writable<PanelMode>("overview");
