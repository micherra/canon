import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { DashboardPanel } from "./dashboard-panel";
import { CANON_DIR, FILES, TIMEOUTS } from "./constants";

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
    const statePath = path.join(workspaceRoot, CANON_DIR, FILES.DASHBOARD_STATE);
    const state = { selectedNode: node, timestamp: new Date().toISOString() };
    fs.promises.writeFile(statePath, JSON.stringify(state, null, 2), "utf-8").catch(() => {
      // .canon dir may not exist yet
    });
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
    activeFileTimer = setTimeout(async () => {
      const workspaceRoot = getWorkspaceRoot();
      if (!workspaceRoot) return;
      const statePath = path.join(workspaceRoot, CANON_DIR, FILES.DASHBOARD_STATE);

      let state: Record<string, unknown> = {};
      try {
        state = JSON.parse(await fs.promises.readFile(statePath, "utf-8"));
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
        await fs.promises.writeFile(statePath, JSON.stringify(state, null, 2), "utf-8");
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
    const statePath = path.join(workspaceRoot, CANON_DIR, FILES.DASHBOARD_STATE);
    fs.promises.unlink(statePath).catch(() => {
      // File may not exist
    });
  }
}
