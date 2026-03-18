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

let activeFileTimer: ReturnType<typeof setTimeout> | undefined;

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("canon.openDashboard", () => {
      DashboardPanel.createOrShow(context);
    }),
    vscode.commands.registerCommand("canon.refreshGraph", () => {
      DashboardPanel.refresh(context);
    })
  );

  // Track active editor file for MCP context injection
  const updateActiveFile = (editor: vscode.TextEditor | undefined) => {
    if (activeFileTimer) clearTimeout(activeFileTimer);
    activeFileTimer = setTimeout(() => {
      const workspaceRoot = getWorkspaceRoot();
      if (!workspaceRoot) return;
      const fs = require("fs");
      const path = require("path");
      const statePath = path.join(workspaceRoot, ".canon", "dashboard-state.json");

      let state: Record<string, unknown> = {};
      try {
        state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
      } catch {
        // No existing state
      }

      if (editor?.document.uri.scheme === "file") {
        const absPath = editor.document.uri.fsPath;
        if (absPath.startsWith(workspaceRoot)) {
          state.activeFile = path.relative(workspaceRoot, absPath);
        }
      } else {
        state.activeFile = null;
      }
      state.timestamp = new Date().toISOString();

      try {
        fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf-8");
      } catch {
        // .canon dir may not exist yet
      }
    }, 500);
  };

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(updateActiveFile)
  );

  // Set initial active file
  updateActiveFile(vscode.window.activeTextEditor);
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
