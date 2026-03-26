export interface EntityInfo {
  name: string;
  kind: string;
  is_exported: boolean;
  line_start?: number;
  line_end?: number;
}

export interface GraphNode {
  id: string;
  layer: string;
  color?: string;
  violation_count?: number;
  top_violations?: string[];
  changed?: boolean;
  summary?: string;
  exports?: string[];
  kind?: string;
  entity_count?: number;
  export_count?: number;
  dead_code_count?: number;
  community?: number;
  entities?: EntityInfo[];
}

export interface GraphEdge {
  source: string | { id: string };
  target: string | { id: string };
  kind?: string;
  relation?: string;
  confidence?: number;
  type?: string;
}

export interface PrincipleInfo {
  title: string;
  severity: string;
  summary: string;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  layers?: Array<{ name: string; color: string; file_count: number; index?: number }>;
  insights?: any;
  principles?: Record<string, PrincipleInfo>;
}
