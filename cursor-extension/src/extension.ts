import * as vscode from "vscode";
import { DashboardPanel } from "./dashboard-panel";

/** Currently selected node in the dashboard graph — written to .canon/dashboard-state.json for MCP access */
export interface SelectedNode {
  id: string;
  layer: string;
  summary: string;
  violation_count: number;
}

let selectedNode: SelectedNode | null = null;

export function getSelectedNode(): SelectedNode | null {
  return selectedNode;
}

export function setSelectedNode(node: SelectedNode | null): void {
  selectedNode = node;

  // Persist to .canon/dashboard-state.json so the MCP server can read it
  const workspaceRoot = getWorkspaceRoot();
  if (workspaceRoot) {
    const fs = require("fs");
    const path = require("path");
    const statePath = path.join(workspaceRoot, ".canon", "dashboard-state.json");
    const state = { selectedNode: node, timestamp: new Date().toISOString() };
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf-8");
  }
}

export function getWorkspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("canon.openDashboard", () => {
      DashboardPanel.createOrShow(context);
    }),
    vscode.commands.registerCommand("canon.refreshGraph", () => {
      DashboardPanel.refresh(context);
    })
  );
}

export function deactivate(): void {
  // Clean up dashboard state file
  const workspaceRoot = getWorkspaceRoot();
  if (workspaceRoot) {
    const fs = require("fs");
    const path = require("path");
    const statePath = path.join(workspaceRoot, ".canon", "dashboard-state.json");
    try {
      fs.unlinkSync(statePath);
    } catch {
      // ignore
    }
  }
}
