import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { readGraphData } from "./services/graph";
import { getCurrentBranch, getChangedFiles } from "./services/git";
import { setSelectedNode, getWorkspaceRoot } from "./extension";

export class DashboardPanel {
  private static instance: DashboardPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private disposables: vscode.Disposable[] = [];
  private fileWatcher: vscode.FileSystemWatcher | undefined;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this.panel = panel;
    this.extensionUri = extensionUri;

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (msg) => this.handleMessage(msg),
      null,
      this.disposables
    );

    this.setupFileWatcher();
    this.update();
  }

  static createOrShow(context: vscode.ExtensionContext): void {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

    if (DashboardPanel.instance) {
      DashboardPanel.instance.panel.reveal(column);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      "canonDashboard",
      "Canon Dashboard",
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(context.extensionUri, "media"),
        ],
      }
    );

    DashboardPanel.instance = new DashboardPanel(panel, context.extensionUri);
  }

  static refresh(context: vscode.ExtensionContext): void {
    if (DashboardPanel.instance) {
      DashboardPanel.instance.update();
    } else {
      DashboardPanel.createOrShow(context);
    }
  }

  private async update(): Promise<void> {
    this.panel.webview.html = await this.getWebviewContent();
  }

  private async handleMessage(msg: { type: string; id?: number; [key: string]: unknown }): Promise<void> {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;

    switch (msg.type) {
      case "getBranch": {
        const branch = await getCurrentBranch(workspaceRoot);
        this.panel.webview.postMessage({ responseId: msg.id, data: { branch } });
        break;
      }
      case "getFile": {
        const filePath = msg.path as string;
        if (!filePath || filePath.startsWith("..") || path.isAbsolute(filePath)) {
          this.panel.webview.postMessage({ responseId: msg.id, error: "Invalid path" });
          break;
        }
        try {
          const fullPath = path.resolve(workspaceRoot, filePath);
          if (!fullPath.startsWith(workspaceRoot + path.sep) && fullPath !== workspaceRoot) {
            this.panel.webview.postMessage({ responseId: msg.id, error: "Invalid path" });
            break;
          }
          const content = fs.readFileSync(fullPath, "utf-8");
          this.panel.webview.postMessage({
            responseId: msg.id,
            data: { content, path: filePath },
          });
        } catch {
          this.panel.webview.postMessage({ responseId: msg.id, error: "File not found" });
        }
        break;
      }
      case "nodeSelected": {
        const node = msg.node as { id: string; layer: string; summary: string; violation_count: number } | null;
        setSelectedNode(node);
        break;
      }
    }
  }

  private async getWebviewContent(): Promise<string> {
    const webview = this.panel.webview;
    const workspaceRoot = getWorkspaceRoot();

    // Load graph data from workspace
    let graphData = "null";
    let prReviews = "null";
    if (workspaceRoot) {
      try {
        const graph = await readGraphData(workspaceRoot);
        // Overlay live git changed files onto graph nodes
        const changedFiles = await getChangedFiles(workspaceRoot);
        const changedSet = new Set(changedFiles);
        for (const node of graph.nodes) {
          node.changed = changedSet.has(node.id);
        }
        graphData = JSON.stringify(graph);
      } catch (err) {
        console.error("[Canon] Failed to load graph data:", err);
      }
      try {
        const prPath = path.join(workspaceRoot, ".canon", "pr-reviews.json");
        prReviews = fs.readFileSync(prPath, "utf-8");
      } catch {
        // No PR reviews file — expected on first run
      }
    }

    // Read the pre-adapted template bundled with the extension
    const templatePath = path.join(this.extensionUri.fsPath, "media", "dashboard-template.html");
    if (!fs.existsSync(templatePath)) {
      return `<html><body><h2>No dashboard template found</h2><p>Extension is missing the dashboard template.</p></body></html>`;
    }
    let html = fs.readFileSync(templatePath, "utf-8");

    // Generate nonce for CSP
    const nonce = getNonce();

    // Replace resource URI placeholders
    const d3Uri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "d3.v7.min.js"));
    const markedUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "marked.min.js"));
    html = html.replace("__D3_URI__", d3Uri.toString());
    html = html.replace("__MARKED_URI__", markedUri.toString());

    // Inject graph data
    html = html.replace("__CANON_GRAPH_DATA__", graphData);
    html = html.replace("__CANON_PR_REVIEWS__", prReviews);

    // Add nonce to all script tags
    html = html.replaceAll("<script", `<script nonce="${nonce}"`);
    // Fix the data scripts (they don't need nonce but it doesn't hurt)

    // Add CSP meta tag
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
      `img-src ${webview.cspSource}`,
    ].join("; ");
    html = html.replace(
      '<meta charset="UTF-8">',
      `<meta charset="UTF-8">\n  <meta http-equiv="Content-Security-Policy" content="${csp}">`
    );

    return html;
  }

  private setupFileWatcher(): void {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;

    // Watch .canon/ data files + git HEAD (branch switches, commits)
    const pattern = new vscode.RelativePattern(workspaceRoot, "{.canon/{graph-data,summaries}.json,.git/HEAD}");
    this.fileWatcher = vscode.workspace.createFileSystemWatcher(pattern);

    const debouncedUpdate = () => {
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => this.update(), 500);
    };

    this.fileWatcher.onDidChange(debouncedUpdate, null, this.disposables);
    this.fileWatcher.onDidCreate(debouncedUpdate, null, this.disposables);
    this.disposables.push(this.fileWatcher);
  }

  private dispose(): void {
    DashboardPanel.instance = undefined;
    setSelectedNode(null);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
  }
}

function getNonce(): string {
  let text = "";
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
