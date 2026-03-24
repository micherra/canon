import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as crypto from "crypto";
import { readGraphData } from "./services/graph";
import { getCurrentBranch, getChangedFiles } from "./services/git";
import { setSelectedNode, getWorkspaceRoot } from "./extension";
import { CANON_DIR, FILES, TIMEOUTS } from "./constants";
import type { WebviewRequest, ExtensionPushMessage } from "./messages";

/**
 * Resolve a relative path within the workspace root, throwing if the result
 * escapes the workspace (path traversal). Returns the absolute path on success.
 */
function safeResolvePath(workspaceRoot: string, relativePath: string): string {
  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error("Invalid path");
  }
  const fullPath = path.resolve(workspaceRoot, relativePath);
  if (!fullPath.startsWith(workspaceRoot + path.sep) && fullPath !== workspaceRoot) {
    throw new Error("Invalid path");
  }
  return fullPath;
}

function isEnoent(err: unknown): boolean {
  return err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT";
}

export class DashboardPanel {
  private static instance: DashboardPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private disposables: vscode.Disposable[] = [];
  private fileWatcher: vscode.FileSystemWatcher | undefined;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;

  private saveDebounceTimer: ReturnType<typeof setTimeout> | undefined;

  private graphTerminal: vscode.Terminal | undefined;
  private summaryPollTimer?: ReturnType<typeof setTimeout>;
  private summaryPollTimeout?: ReturnType<typeof setTimeout>;
  private summaryPollTotal?: number;
  private disposed = false;
  private generationInProgress = false;
  private generationTimeout?: ReturnType<typeof setTimeout>;

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
    this.setupSaveListener();
    this.initDashboard();
  }

  /** Load data and auto-generate if missing */
  private async initDashboard(): Promise<void> {
    const workspaceRoot = getWorkspaceRoot();
    const graphPath = workspaceRoot ? path.join(workspaceRoot, CANON_DIR, FILES.GRAPH_DATA) : null;
    const hasGraph = graphPath && fs.existsSync(graphPath);

    // Render the webview HTML shell once (embeds graph data if available)
    await this.update();

    if (!hasGraph) {
      // Notify webview that generation is starting, then kick it off
      this.panel.webview.postMessage({ type: "graphStatus", status: "generating" });
      this.runGraphGeneration();
    }
    // Summary check is deferred until webview sends "ready" message
  }

  // ── Data Push (message-based, no HTML re-render) ──

  /** Push graph data to webview via postMessage — no HTML teardown */
  private async pushGraphData(): Promise<void> {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;
    try {
      const graph = await readGraphData(workspaceRoot);
      const changedFiles = await getChangedFiles(workspaceRoot);
      const changedSet = new Set(changedFiles);
      // Create new nodes with changed flag (avoid mutating cached data)
      graph.nodes = graph.nodes.map((n) => ({ ...n, changed: changedSet.has(n.id) }));
      this.panel.webview.postMessage({ type: "graphData", data: graph });
    } catch (err) {
      console.error("[Canon] Failed to push graph data:", err);
      this.panel.webview.postMessage({ type: "graphStatus", status: "error" });
    }
  }

  /** Push graph data and check if summaries need generating */
  private async pushGraphDataAndCheckSummaries(): Promise<void> {
    await this.pushGraphData();
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;
    const graphPath = path.join(workspaceRoot, CANON_DIR, FILES.GRAPH_DATA);
    this.runSummariesIfNeeded(workspaceRoot, graphPath).catch((err) => {
      console.error("[Canon] Summary check failed:", err);
    });
  }

  /** Push PR review data to webview */
  private async pushPrReviews(workspaceRoot: string): Promise<void> {
    try {
      const prPath = path.join(workspaceRoot, CANON_DIR, FILES.PR_REVIEWS);
      const raw = await fs.promises.readFile(prPath, "utf-8");
      const entries = raw
        .split("\n")
        .filter((l) => l.trim() !== "")
        .flatMap((l) => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(l);
          } catch {
            console.warn("[Canon] Skipping invalid JSONL line in pr-reviews (parse error):", l.slice(0, 80));
            return [];
          }
          if (
            typeof parsed !== "object" ||
            parsed === null ||
            typeof (parsed as Record<string, unknown>).pr !== "number" ||
            typeof (parsed as Record<string, unknown>).result !== "string"
          ) {
            console.warn("[Canon] Skipping pr-reviews entry with missing/invalid fields:", parsed);
            return [];
          }
          return [parsed];
        });
      this.panel.webview.postMessage({ type: "prReviews", data: entries });
    } catch (err) {
      if (!isEnoent(err)) console.warn("[Canon] Failed to read pr-reviews:", err);
    }
  }

  // ── Summary Polling ──

  /** Check if any graph files are missing from summaries and generate them */
  private async runSummariesIfNeeded(workspaceRoot: string, graphPath: string): Promise<void> {
    try {
      const graphRaw = await fs.promises.readFile(graphPath, "utf-8");
      const parsedGraph = JSON.parse(graphRaw) as { nodes?: Array<{ id?: unknown }> };
      const nodes = Array.isArray(parsedGraph.nodes) ? parsedGraph.nodes : [];
      const fileIds = new Set<string>(
        nodes
          .map((n) => n.id)
          .filter((id): id is string => typeof id === "string")
      );
      if (fileIds.size === 0) return;

      const sumPath = path.join(workspaceRoot, CANON_DIR, FILES.SUMMARIES);
      let existingSummaries = new Set<string>();
      try {
        const sumRaw = await fs.promises.readFile(sumPath, "utf-8");
        existingSummaries = new Set(Object.keys(JSON.parse(sumRaw)));
      } catch (err) {
        if (!isEnoent(err)) console.warn("[Canon] Failed to read summaries.json:", err);
      }

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
    } catch (err) {
      if (!isEnoent(err)) console.warn("[Canon] Failed to check summaries:", err);
    }
  }

  /** Poll summaries.json to track progress during generation (async, self-scheduling) */
  private startSummaryPolling(workspaceRoot: string, graphPath: string): void {
    this.clearSummaryPolling();

    // Capture total once at start to avoid moving target if graph updates mid-poll.
    // Read asynchronously so we don't block the extension host.
    fs.promises.readFile(graphPath, "utf-8").then((graphRaw) => {
      const total: number = (JSON.parse(graphRaw).nodes || []).length;
      if (!total || this.disposed) return;
      this.summaryPollTotal = total;

      // Safety deadline: stop polling after the generation timeout
      this.summaryPollTimeout = setTimeout(() => {
        this.clearSummaryPolling();
      }, TIMEOUTS.GENERATION_TIMEOUT_MS);

      const tick = () => {
        if (this.disposed) {
          this.clearSummaryPolling();
          return;
        }
        const sumPath = path.join(workspaceRoot, CANON_DIR, FILES.SUMMARIES);
        fs.promises.readFile(sumPath, "utf-8")
          .then((sumRaw) => {
            if (this.disposed) { this.clearSummaryPolling(); return; }
            const completed = Object.keys(JSON.parse(sumRaw)).length;
            this.panel.webview.postMessage({ type: "summaryProgress", completed, total });
            if (completed >= total) {
              this.clearSummaryPolling();
            } else {
              this.summaryPollTimer = setTimeout(tick, 2000);
            }
          })
          .catch((err) => {
            if (!isEnoent(err)) console.warn("[Canon] Summary poll error:", err);
            if (!this.disposed) this.summaryPollTimer = setTimeout(tick, 2000);
          });
      };

      this.summaryPollTimer = setTimeout(tick, 2000);
    }).catch(() => {
      // If the graph file can't be read, abort polling silently
    });
  }

  private clearSummaryPolling(): void {
    if (this.summaryPollTimer) {
      clearTimeout(this.summaryPollTimer);
      this.summaryPollTimer = undefined;
    }
    if (this.summaryPollTimeout) {
      clearTimeout(this.summaryPollTimeout);
      this.summaryPollTimeout = undefined;
    }
  }

  // ── Panel Lifecycle ──

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
      DashboardPanel.instance.pushGraphData().catch((err) => {
        console.error("[Canon] Failed to refresh dashboard:", err);
      });
    } else {
      DashboardPanel.createOrShow(context);
    }
  }

  /** Render full HTML shell — only called once during initDashboard() */
  private async update(): Promise<void> {
    this.panel.webview.html = await this.getWebviewContent();
  }

  // ── Message Handling ──

  private async handleMessage(msg: WebviewRequest): Promise<void> {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;

    switch (msg.type) {
      case "webviewReady": return this.onWebviewReady(workspaceRoot);
      case "getBranch": return this.onGetBranch(workspaceRoot, msg.id!);
      case "getFile": return this.onGetFile(workspaceRoot, msg.path as string, msg.id!);
      case "getSummary": return this.onGetSummary(workspaceRoot, msg.fileId as string, msg.id!);
      case "getComplianceTrend": return this.onGetComplianceTrend(workspaceRoot, msg.principleId as string, msg.id!);
      case "nodeSelected": return this.onNodeSelected(msg.node as any);
      case "openFile": return this.onOpenFile(workspaceRoot, msg.path as string);
      case "refreshGraph": return this.onRefreshGraph();
    }
  }

  private onWebviewReady(workspaceRoot: string): void {
    this.pushPrReviews(workspaceRoot).catch((err) => {
      console.warn("[Canon] Failed to push PR reviews:", err);
    });
    const graphPath = path.join(workspaceRoot, CANON_DIR, FILES.GRAPH_DATA);
    if (fs.existsSync(graphPath)) {
      this.runSummariesIfNeeded(workspaceRoot, graphPath).catch((err) => {
        console.error("[Canon] Summary check failed:", err);
      });
    }
  }

  private async onGetBranch(workspaceRoot: string, id: number): Promise<void> {
    const branch = await getCurrentBranch(workspaceRoot);
    this.panel.webview.postMessage({ responseId: id, data: { branch } });
  }

  private onGetFile(workspaceRoot: string, filePath: string, id: number): void {
    try {
      const fullPath = safeResolvePath(workspaceRoot, filePath);
      const content = fs.readFileSync(fullPath, "utf-8");
      this.panel.webview.postMessage({ responseId: id, data: { content, path: filePath } });
    } catch {
      this.panel.webview.postMessage({ responseId: id, error: "Invalid path or file not found" });
    }
  }

  private onGetSummary(workspaceRoot: string, fileId: string, id: number): void {
    try {
      safeResolvePath(workspaceRoot, fileId);
    } catch {
      this.panel.webview.postMessage({ responseId: id, data: { summary: null } });
      return;
    }
    // Try summaries.json first
    try {
      const sumPath = path.join(workspaceRoot, CANON_DIR, FILES.SUMMARIES);
      const raw = fs.readFileSync(sumPath, "utf-8");
      const summaries = JSON.parse(raw) as Record<string, unknown>;
      const entry = summaries[fileId];
      if (entry !== undefined) {
        if (typeof entry === "string") {
          this.panel.webview.postMessage({ responseId: id, data: { summary: entry } });
          return;
        } else if (
          typeof entry === "object" &&
          entry !== null &&
          typeof (entry as Record<string, unknown>).summary === "string"
        ) {
          this.panel.webview.postMessage({ responseId: id, data: { summary: (entry as { summary: string }).summary } });
          return;
        } else {
          console.warn("[Canon] Skipping summary entry with unexpected shape for", fileId, ":", entry);
        }
      }
    } catch (err) {
      if (!isEnoent(err)) console.warn("[Canon] Failed to read summaries.json:", err);
    }
    // Fallback: read first few lines
    try {
      const fullPath = safeResolvePath(workspaceRoot, fileId);
      const content = fs.readFileSync(fullPath, "utf-8");
      const lines = content.split("\n").slice(0, 5).join("\n").trim();
      this.panel.webview.postMessage({ responseId: id, data: { summary: lines ? `${lines}...` : null } });
    } catch {
      this.panel.webview.postMessage({ responseId: id, data: { summary: null } });
    }
  }

  private onGetComplianceTrend(workspaceRoot: string, principleId: string, id: number): void {
    try {
      const reviewsPath = path.join(workspaceRoot, CANON_DIR, FILES.REVIEWS);
      if (!fs.existsSync(reviewsPath)) {
        this.panel.webview.postMessage({ responseId: id, data: { trend: [] } });
        return;
      }
      const raw = fs.readFileSync(reviewsPath, "utf-8");
      const lines = raw.split("\n").filter((l) => l.trim());

      // Bucket reviews by ISO week
      const weeks = new Map<string, { pass: number; total: number }>();
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (entry.principle_id !== principleId || !entry.timestamp) continue;
          const d = new Date(entry.timestamp);
          // ISO week key: year-Wxx
          const jan4 = new Date(d.getFullYear(), 0, 4);
          const weekNum = Math.ceil(((d.getTime() - jan4.getTime()) / 86400000 + jan4.getDay() + 1) / 7);
          const weekKey = `${d.getFullYear()}-W${String(weekNum).padStart(2, "0")}`;
          const bucket = weeks.get(weekKey) || { pass: 0, total: 0 };
          bucket.total++;
          if (entry.passed || entry.verdict === "pass") bucket.pass++;
          weeks.set(weekKey, bucket);
        } catch { /* skip malformed lines */ }
      }

      // Sort by week key, compute pass rates
      const sorted = [...weeks.entries()].sort((a, b) => a[0].localeCompare(b[0]));
      const trend = sorted.map(([week, { pass, total }]) => ({
        week,
        pass_rate: total > 0 ? pass / total : 0,
      }));

      this.panel.webview.postMessage({ responseId: id, data: { trend } });
    } catch {
      this.panel.webview.postMessage({ responseId: id, data: { trend: [] } });
    }
  }

  private onNodeSelected(node: { id: string; layer: string; summary: string; violation_count: number } | null): void {
    setSelectedNode(node);
  }

  private onOpenFile(workspaceRoot: string, filePath: string): void {
    try {
      const fullPath = safeResolvePath(workspaceRoot, filePath);
      const uri = vscode.Uri.file(fullPath);
      vscode.window.showTextDocument(uri, { preview: true });
    } catch {
      // Invalid path — ignore silently
    }
  }

  private onRefreshGraph(): void {
    this.postToWebview({ type: "graphStatus", status: "refreshing" });
    this.runGraphGeneration();
  }

  /** Type-safe wrapper for posting messages to the webview. */
  private postToWebview(msg: ExtensionPushMessage): void {
    this.panel.webview.postMessage(msg);
  }

  // ── HTML Template (initial render only) ──

  private async getWebviewContent(): Promise<string> {
    const webview = this.panel.webview;
    const workspaceRoot = getWorkspaceRoot();

    // Embed graph data if available (fast startup on re-open)
    let graphData = "null";
    let graphExists = false;
    if (workspaceRoot) {
      try {
        const graph = await readGraphData(workspaceRoot);
        graphExists = true;
        const changedFiles = await getChangedFiles(workspaceRoot);
        const changedSet = new Set(changedFiles);
        for (const node of graph.nodes) {
          node.changed = changedSet.has(node.id);
        }
        graphData = JSON.stringify(graph);
      } catch (err) {
        console.error("[Canon] Failed to load graph data:", err);
      }
    }

    const templatePath = path.join(this.extensionUri.fsPath, "media", "dashboard.html");
    if (!fs.existsSync(templatePath)) {
      return `<html><body><h2>No dashboard template found</h2><p>Extension is missing the dashboard template.</p></body></html>`;
    }
    let html = fs.readFileSync(templatePath, "utf-8");

    const nonce = getNonce();

    const markedUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "marked.min.js"));
    const dashboardJsUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "dashboard.js"));
    html = html.replaceAll("__MARKED_URI__", markedUri.toString());
    html = html.replaceAll("__DASHBOARD_JS_URI__", dashboardJsUri.toString());

    const graphStatus = graphExists ? "ready" : "empty";
    // Escape </script> sequences to prevent XSS when embedding JSON in script tags
    const safeGraphData = graphData.replaceAll("</", "<\\/");
    html = html.replaceAll("__CANON_GRAPH_DATA__", safeGraphData);
    // PR reviews loaded via message after webviewReady, not embedded
    html = html.replaceAll("__CANON_PR_REVIEWS__", "null");
    html = html.replaceAll("__CANON_GRAPH_STATUS__", graphStatus);

    html = html.replaceAll("<script", `<script nonce="${nonce}"`);

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

  // ── Terminal & Generation ──

  private findPluginDir(): string | null {
    const home = process.env.HOME || process.env.USERPROFILE || "";
    const candidates = [
      path.resolve(this.extensionUri.fsPath, ".."),
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

  private runGraphGeneration(): void {
    if (this.generationInProgress) return;
    this.generationInProgress = true;
    // Safety timeout: reset flag after 10 minutes if generation never completes
    if (this.generationTimeout) clearTimeout(this.generationTimeout);
    this.generationTimeout = setTimeout(() => {
      this.generationInProgress = false;
      this.generationTimeout = undefined;
    }, TIMEOUTS.GENERATION_TIMEOUT_MS);
    const pf = this.getPluginFlag();
    const allow = `--allowedTools "mcp__canon__*,Read,Grep,Glob"`;
    const graphCmd = `claude ${pf}${allow} -p "Call the codebase_graph MCP tool with no arguments."`;
    const summaryCmd = `claude ${pf}${allow} -p "Read .canon/graph-data.json to get the list of files. Also read .canon/summaries.json if it exists to see which files already have summaries. For each file that has no summary, read the file and write a 1-2 sentence summary describing the file's purpose and its architectural role. Call store_summaries after each file so progress is saved incrementally."`;

    const term = this.getOrCreateTerminal();
    term.sendText(graphCmd);
  }

  private runSummaryGeneration(): void {
    if (this.generationInProgress) return;
    this.generationInProgress = true;
    const pf = this.getPluginFlag();
    const allow = `--allowedTools "mcp__canon__*,Read,Grep,Glob"`;
    const summaryCmd = `claude ${pf}${allow} -p "Read .canon/graph-data.json to get the list of files. Also read .canon/summaries.json if it exists to see which files already have summaries. For each file that has no summary, read the file and write a 1-2 sentence summary describing the file's purpose and its architectural role. Call store_summaries after each file so progress is saved incrementally."`;

    const term = this.getOrCreateTerminal();
    term.sendText(summaryCmd);
  }

  private sendSummaryProgress(workspaceRoot: string): void {
    try {
      const graphRaw = fs.readFileSync(path.join(workspaceRoot, CANON_DIR, FILES.GRAPH_DATA), "utf-8");
      const totalFiles = (JSON.parse(graphRaw).nodes || []).length;
      const sumRaw = fs.readFileSync(path.join(workspaceRoot, CANON_DIR, FILES.SUMMARIES), "utf-8");
      const summaryCount = Object.keys(JSON.parse(sumRaw)).length;
      this.panel.webview.postMessage({
        type: "summaryProgress",
        completed: summaryCount,
        total: totalFiles,
      });
    } catch (err) {
      if (!isEnoent(err)) console.warn("[Canon] Summary progress read failed:", err);
    }
  }

  // ── File Watcher ──

  private setupFileWatcher(): void {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;

    const pattern = new vscode.RelativePattern(workspaceRoot, "{.canon/{graph-data,summaries}.json,.git/HEAD}");
    this.fileWatcher = vscode.workspace.createFileSystemWatcher(pattern);

    const debouncedUpdate = (uri: vscode.Uri) => {
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => {
        if (uri.fsPath.endsWith("summaries.json")) {
          this.sendSummaryProgress(workspaceRoot);
        } else {
          if (uri.fsPath.endsWith("graph-data.json")) this.generationInProgress = false;
          if (this.generationTimeout) { clearTimeout(this.generationTimeout); this.generationTimeout = undefined; }
          console.log("[Canon] File watcher triggered, pushing graph data");
          this.pushGraphDataAndCheckSummaries().catch((err) => {
            console.error("[Canon] Failed to push graph data:", err);
          });
        }
      }, 500);
    };

    this.fileWatcher.onDidChange(debouncedUpdate, null, this.disposables);
    this.fileWatcher.onDidCreate(debouncedUpdate, null, this.disposables);
    this.disposables.push(this.fileWatcher);

    // Poll for graph-data.json when it doesn't exist yet
    const graphPath = path.join(workspaceRoot, CANON_DIR, FILES.GRAPH_DATA);
    if (!fs.existsSync(graphPath)) {
      const pollInterval = setInterval(() => {
        if (fs.existsSync(graphPath)) {
          clearInterval(pollInterval);
          this.generationInProgress = false;
          if (this.generationTimeout) { clearTimeout(this.generationTimeout); this.generationTimeout = undefined; }
          console.log("[Canon] graph-data.json detected via polling, pushing data");
          this.pushGraphDataAndCheckSummaries().catch((err) => {
            console.error("[Canon] Failed to push graph data:", err);
          });
        }
      }, 2000);
      const pollTimeout = setTimeout(() => clearInterval(pollInterval), TIMEOUTS.POLL_TIMEOUT_MS);
      this.disposables.push({ dispose: () => {
        clearInterval(pollInterval);
        clearTimeout(pollTimeout);
      }});
    }
  }

  // ── Save Listener ──

  /** Watch for source file saves and notify the webview that a reindex may be pending. */
  private setupSaveListener(): void {
    const listener = vscode.workspace.onDidSaveTextDocument((doc) => {
      const filePath = doc.uri.fsPath;
      // Skip non-source files: node_modules, .git internals, and .canon data files
      if (
        filePath.includes(`${path.sep}node_modules${path.sep}`) ||
        filePath.includes(`${path.sep}.git${path.sep}`) ||
        filePath.includes(`${path.sep}.canon${path.sep}`)
      ) {
        return;
      }

      // Debounce — only post once per burst of rapid saves
      if (this.saveDebounceTimer) clearTimeout(this.saveDebounceTimer);
      this.saveDebounceTimer = setTimeout(() => {
        this.saveDebounceTimer = undefined;
        this.postToWebview({ type: "graphStatus", status: "reindexing" });
      }, 500);
    });
    this.disposables.push(listener);
  }

  private dispose(): void {
    this.disposed = true;
    DashboardPanel.instance = undefined;
    setSelectedNode(null);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.saveDebounceTimer) clearTimeout(this.saveDebounceTimer);
    if (this.generationTimeout) clearTimeout(this.generationTimeout);
    this.clearSummaryPolling();
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
  }
}

export function isValidRelativePath(filePath: string, workspaceRoot: string): boolean {
  try {
    safeResolvePath(workspaceRoot, filePath);
    return true;
  } catch {
    return false;
  }
}

export function getNonce(): string {
  return crypto.randomBytes(16).toString("hex");
}
