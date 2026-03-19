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

  private graphTerminal: vscode.Terminal | undefined;

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
    this.initDashboard();
  }

  /** Load data and auto-generate if missing */
  private async initDashboard(): Promise<void> {
    const workspaceRoot = getWorkspaceRoot();
    const graphPath = workspaceRoot ? path.join(workspaceRoot, ".canon", "graph-data.json") : null;
    const hasGraph = graphPath && fs.existsSync(graphPath);

    // Always render the webview (shows loading state if no data)
    await this.update();

    if (!hasGraph) {
      this.runGraphGeneration();
    }
    // Summary check is deferred until webview sends "ready" message
  }

  private summaryPollTimer?: ReturnType<typeof setInterval>;

  /** Check if any graph files are missing from summaries and generate them */
  private async runSummariesIfNeeded(workspaceRoot: string, graphPath: string): Promise<void> {
    try {
      const graphRaw = await fs.promises.readFile(graphPath, "utf-8");
      const nodes = JSON.parse(graphRaw).nodes || [];
      const fileIds = new Set(nodes.map((n: any) => n.id));
      if (fileIds.size === 0) return;

      const sumPath = path.join(workspaceRoot, ".canon", "summaries.json");
      let existingSummaries = new Set<string>();
      try {
        const sumRaw = await fs.promises.readFile(sumPath, "utf-8");
        existingSummaries = new Set(Object.keys(JSON.parse(sumRaw)));
      } catch { /* no summaries file yet */ }

      const missing = [...fileIds].filter((id) => !existingSummaries.has(id));
      if (missing.length > 0) {
        const total = fileIds.size;
        this.panel.webview.postMessage({
          type: "summaryProgress",
          completed: total - missing.length,
          total,
        });
        this.runSummaryGeneration();
        this.startSummaryPolling(workspaceRoot, graphPath);
      }
    } catch { /* ignore parse errors */ }
  }

  /** Poll summaries.json to track progress during generation */
  private startSummaryPolling(workspaceRoot: string, graphPath: string): void {
    if (this.summaryPollTimer) clearInterval(this.summaryPollTimer);

    this.summaryPollTimer = setInterval(() => {
      try {
        const graphRaw = fs.readFileSync(graphPath, "utf-8");
        const total = (JSON.parse(graphRaw).nodes || []).length;
        const sumPath = path.join(workspaceRoot, ".canon", "summaries.json");
        const sumRaw = fs.readFileSync(sumPath, "utf-8");
        const completed = Object.keys(JSON.parse(sumRaw)).length;

        this.panel.webview.postMessage({
          type: "summaryProgress",
          completed,
          total,
        });

        // Stop polling when done
        if (completed >= total) {
          clearInterval(this.summaryPollTimer!);
          this.summaryPollTimer = undefined;
        }
      } catch { /* ignore */ }
    }, 2000);

    // Stop after 10 minutes
    setTimeout(() => {
      if (this.summaryPollTimer) {
        clearInterval(this.summaryPollTimer);
        this.summaryPollTimer = undefined;
      }
    }, 600000);

    this.disposables.push({ dispose: () => {
      if (this.summaryPollTimer) clearInterval(this.summaryPollTimer);
    }});
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
      case "webviewReady": {
        // Webview is loaded — check if summaries need generating
        const graphPath = path.join(workspaceRoot, ".canon", "graph-data.json");
        if (fs.existsSync(graphPath)) {
          this.runSummariesIfNeeded(workspaceRoot, graphPath);
        }
        break;
      }
      case "getBranch": {
        const branch = await getCurrentBranch(workspaceRoot);
        this.panel.webview.postMessage({ responseId: msg.id, data: { branch } });
        break;
      }
      case "getFile": {
        const filePath = msg.path as string;
        if (!isValidRelativePath(filePath, workspaceRoot)) {
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
      case "getSummary": {
        const fileId = msg.fileId as string;
        if (!fileId || !isValidRelativePath(fileId, workspaceRoot)) {
          this.panel.webview.postMessage({ responseId: msg.id, data: { summary: null } });
          break;
        }
        // Try summaries.json first
        try {
          const sumPath = path.join(workspaceRoot, ".canon", "summaries.json");
          const raw = fs.readFileSync(sumPath, "utf-8");
          const summaries = JSON.parse(raw) as Record<string, string | { summary: string }>;
          const entry = summaries[fileId];
          if (entry) {
            const summary = typeof entry === "string" ? entry : entry.summary || "";
            this.panel.webview.postMessage({ responseId: msg.id, data: { summary } });
            break;
          }
        } catch { /* no summaries file */ }
        // Fallback: read first few lines of the file
        try {
          const fullPath = path.resolve(workspaceRoot, fileId);
          const content = fs.readFileSync(fullPath, "utf-8");
          const lines = content.split("\n").slice(0, 5).join("\n").trim();
          this.panel.webview.postMessage({ responseId: msg.id, data: { summary: lines ? `${lines}...` : null } });
        } catch {
          this.panel.webview.postMessage({ responseId: msg.id, data: { summary: null } });
        }
        break;
      }
      case "nodeSelected": {
        const node = msg.node as { id: string; layer: string; summary: string; violation_count: number } | null;
        setSelectedNode(node);
        break;
      }
      case "refreshGraph": {
        this.runGraphGeneration();
        break;
      }
    }
  }

  private async getWebviewContent(): Promise<string> {
    const webview = this.panel.webview;
    const workspaceRoot = getWorkspaceRoot();

    // Load graph data from workspace
    let graphData = "null";
    let graphExists = false;
    let prReviews = "null";
    if (workspaceRoot) {
      try {
        const graph = await readGraphData(workspaceRoot);
        graphExists = true;
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
        const prPath = path.join(workspaceRoot, ".canon", "pr-reviews.jsonl");
        const raw = fs.readFileSync(prPath, "utf-8");
        const entries = raw.split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l));
        prReviews = JSON.stringify(entries);
      } catch {
        // No PR reviews file — expected on first run
      }
    }

    // Read the HTML shell bundled with the extension
    const templatePath = path.join(this.extensionUri.fsPath, "media", "dashboard.html");
    if (!fs.existsSync(templatePath)) {
      return `<html><body><h2>No dashboard template found</h2><p>Extension is missing the dashboard template.</p></body></html>`;
    }
    let html = fs.readFileSync(templatePath, "utf-8");

    // Generate nonce for CSP
    const nonce = getNonce();

    // Replace resource URI placeholders
    const d3Uri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "d3.v7.min.js"));
    const markedUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "marked.min.js"));
    const dashboardJsUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "dashboard.js"));
    html = html.replace("__D3_URI__", d3Uri.toString());
    html = html.replace("__MARKED_URI__", markedUri.toString());
    html = html.replace("__DASHBOARD_JS_URI__", dashboardJsUri.toString());

    // Inject graph data and generation status
    const graphStatus = graphExists ? "ready" : "empty";
    html = html.replace("__CANON_GRAPH_DATA__", graphData);
    html = html.replace("__CANON_PR_REVIEWS__", prReviews);
    html = html.replace("__CANON_GRAPH_STATUS__", graphStatus);

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

  /** Resolve the Canon plugin directory */
  private findPluginDir(): string | null {
    const home = process.env.HOME || process.env.USERPROFILE || "";
    const candidates = [
      // Monorepo sibling (development)
      path.resolve(this.extensionUri.fsPath, ".."),
      // Installed plugin cache
      path.join(home, ".claude", "plugins", "cache", "canon"),
    ];
    for (const dir of candidates) {
      if (fs.existsSync(path.join(dir, "mcp-server"))) return dir;
    }
    return null;
  }

  private getPluginFlag(): string {
    const pluginDir = this.findPluginDir();
    return pluginDir ? `--plugin-dir "${pluginDir}" ` : "";
  }

  private getOrCreateTerminal(): vscode.Terminal {
    if (!this.graphTerminal || this.graphTerminal.exitStatus !== undefined) {
      this.graphTerminal = vscode.window.createTerminal({ name: "Canon" });
    }
    this.graphTerminal.show();
    return this.graphTerminal;
  }

  /** Run codebase_graph via Claude CLI in a terminal, then generate summaries */
  private runGraphGeneration(): void {
    const pf = this.getPluginFlag();
    const graphCmd = `claude ${pf}-p "Call the codebase_graph MCP tool with no arguments."`;
    const summaryCmd = `claude ${pf}-p "Read .canon/graph-data.json to get the list of files. Also read .canon/summaries.json if it exists to see which files already have summaries. For each file that has no summary, read the file and write a 1-2 sentence summary describing the file's purpose and its architectural role. Call store_summaries after each file so progress is saved incrementally."`;

    const term = this.getOrCreateTerminal();
    term.sendText(`${graphCmd} && ${summaryCmd}`);
  }

  /** Run only summary generation (graph already exists) */
  private runSummaryGeneration(): void {
    const pf = this.getPluginFlag();
    const summaryCmd = `claude ${pf}-p "Read .canon/graph-data.json to get the list of files. Also read .canon/summaries.json if it exists to see which files already have summaries. For each file that has no summary, read the file and write a 1-2 sentence summary describing the file's purpose and its architectural role. Call store_summaries after each file so progress is saved incrementally."`;

    const term = this.getOrCreateTerminal();
    term.sendText(summaryCmd);
  }

  private sendSummaryProgress(workspaceRoot: string): void {
    try {
      const graphRaw = fs.readFileSync(path.join(workspaceRoot, ".canon", "graph-data.json"), "utf-8");
      const totalFiles = (JSON.parse(graphRaw).nodes || []).length;
      const sumRaw = fs.readFileSync(path.join(workspaceRoot, ".canon", "summaries.json"), "utf-8");
      const summaryCount = Object.keys(JSON.parse(sumRaw)).length;
      this.panel.webview.postMessage({
        type: "summaryProgress",
        completed: summaryCount,
        total: totalFiles,
      });
    } catch { /* ignore */ }
  }

  private setupFileWatcher(): void {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;

    // Watch .canon/ data files + git HEAD (branch switches, commits)
    const pattern = new vscode.RelativePattern(workspaceRoot, "{.canon/{graph-data,summaries}.json,.git/HEAD}");
    this.fileWatcher = vscode.workspace.createFileSystemWatcher(pattern);

    const debouncedUpdate = (uri: vscode.Uri) => {
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => {
        if (uri.fsPath.endsWith("summaries.json")) {
          // Push summary progress to webview without full re-render
          this.sendSummaryProgress(workspaceRoot);
        } else {
          console.log("[Canon] File watcher triggered, refreshing dashboard");
          this.update();
        }
      }, 500);
    };

    this.fileWatcher.onDidChange(debouncedUpdate, null, this.disposables);
    this.fileWatcher.onDidCreate(debouncedUpdate, null, this.disposables);
    this.disposables.push(this.fileWatcher);

    // Also poll for graph-data.json when it doesn't exist yet (file watchers
    // can miss creation if the .canon/ directory didn't exist when the watcher was set up)
    const graphPath = path.join(workspaceRoot, ".canon", "graph-data.json");
    if (!fs.existsSync(graphPath)) {
      const pollInterval = setInterval(() => {
        if (fs.existsSync(graphPath)) {
          clearInterval(pollInterval);
          console.log("[Canon] graph-data.json detected via polling, refreshing dashboard");
          this.update();
        }
      }, 2000);
      // Stop polling after 5 minutes
      setTimeout(() => clearInterval(pollInterval), 300000);
      this.disposables.push({ dispose: () => clearInterval(pollInterval) });
    }
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

export function isValidRelativePath(filePath: string, workspaceRoot: string): boolean {
  if (!filePath || filePath.startsWith("..") || path.isAbsolute(filePath)) return false;
  const fullPath = path.resolve(workspaceRoot, filePath);
  return fullPath.startsWith(workspaceRoot + path.sep) || fullPath === workspaceRoot;
}

export function getNonce(): string {
  let text = "";
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
