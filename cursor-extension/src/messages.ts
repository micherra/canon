/** Typed message protocol between extension and webview. */

import type { SelectedNode } from "./extension";

// ── Extension → Webview (push messages) ──

export type ExtensionPushMessage =
  | { type: "graphData"; data: unknown }
  | { type: "graphStatus"; status: "ready" | "generating" | "refreshing" | "error" | "empty" }
  | { type: "prReviews"; data: unknown[] }
  | { type: "summaryProgress"; completed: number; total: number };

// ── Webview → Extension (requests via bridge) ──

export type WebviewRequestType =
  | "webviewReady"
  | "getBranch"
  | "getFile"
  | "getSummary"
  | "getComplianceTrend"
  | "nodeSelected"
  | "refreshGraph";

export interface WebviewRequest {
  type: WebviewRequestType;
  id?: number;
  [key: string]: unknown;
}

// ── Response messages (extension → webview, matched by responseId) ──

export interface WebviewResponse {
  responseId: number;
  data?: unknown;
  error?: string;
}
