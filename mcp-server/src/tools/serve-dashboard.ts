/** Canon dashboard — deploys the HTML and serves it with live API endpoints. */

import { createServer, type Server } from "http";
import { execFile, spawn } from "child_process";
import { readFile } from "fs/promises";
import { join, normalize } from "path";
import { deployDashboard } from "./deploy-dashboard.js";
import { askCodebase } from "./ask-codebase.js";
import { getFileContext } from "./get-file-context.js";

let activeServer: Server | null = null;

export interface ServeDashboardOutput {
  deployed: boolean;
  dashboard_path: string;
  url: string;
  port: number;
  message: string;
  unsummarized_files: string[];
}

/** Build a concise system prompt with graph context for Claude */
async function buildGraphContext(projectDir: string): Promise<string> {
  try {
    const raw = await readFile(join(projectDir, ".canon", "graph-data.json"), "utf-8");
    const graph = JSON.parse(raw);
    const nodes = (graph.nodes || []) as Array<{ id: string; layer: string; violation_count: number; summary?: string }>;
    const edges = (graph.edges || []) as Array<{ source: string; target: string }>;

    // Load summaries
    let summaries: Record<string, string> = {};
    try {
      const sumRaw = await readFile(join(projectDir, ".canon", "summaries.json"), "utf-8");
      const sumData = JSON.parse(sumRaw);
      for (const [k, v] of Object.entries(sumData)) {
        summaries[k] = typeof v === "string" ? v : (v as { summary: string }).summary || "";
      }
    } catch { /* no summaries */ }

    // Build compact context
    const layerCounts = new Map<string, number>();
    for (const n of nodes) {
      layerCounts.set(n.layer, (layerCounts.get(n.layer) || 0) + 1);
    }

    const lines: string[] = [
      `Codebase: ${nodes.length} files, ${edges.length} dependencies.`,
      `Layers: ${Array.from(layerCounts.entries()).map(([l, c]) => `${l}(${c})`).join(", ")}`,
      "",
      "Files:",
    ];

    for (const n of nodes) {
      const summary = summaries[n.id] || n.summary || "";
      const parts = [n.id, `[${n.layer}]`];
      if (n.violation_count > 0) parts.push(`violations:${n.violation_count}`);
      if (summary) parts.push(`— ${summary}`);
      lines.push(parts.join(" "));
    }

    // Add dependency info (compact)
    const depMap = new Map<string, string[]>();
    for (const e of edges) {
      const src = typeof e.source === "string" ? e.source : (e.source as unknown as { id: string }).id;
      const tgt = typeof e.target === "string" ? e.target : (e.target as unknown as { id: string }).id;
      if (!depMap.has(src)) depMap.set(src, []);
      depMap.get(src)!.push(tgt.split("/").pop() || tgt);
    }

    lines.push("", "Dependencies:");
    for (const [src, targets] of depMap) {
      lines.push(`${src} → ${targets.join(", ")}`);
    }

    return lines.join("\n");
  } catch {
    return "No codebase graph data available.";
  }
}

/** Call claude CLI with the question and graph context, return the answer */
function askClaude(question: string, graphContext: string, projectDir: string): Promise<string> {
  return new Promise((resolve) => {
    const systemPrompt = [
      "You are an expert on this codebase. Answer questions about the architecture, files, dependencies, and patterns.",
      "Be concise but thorough. Reference specific file names when relevant.",
      "Use markdown formatting: **bold** for file names, `code` for code terms, bullet lists for multiple items.",
      "",
      "Here is the codebase context:",
      graphContext,
    ].join("\n");

    const proc = spawn("claude", [
      "--print",
      "--system-prompt", systemPrompt,
      "--max-turns", "1",
      "--model", "claude-haiku-4-5-20251001",
      question,
    ], {
      cwd: projectDir,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30000,
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    proc.on("close", (code) => {
      if (code === 0 && stdout.trim()) {
        resolve(stdout.trim());
      } else {
        resolve(`Error calling Claude CLI (exit ${code}): ${stderr.trim() || "unknown error"}`);
      }
    });

    proc.on("error", (err) => {
      resolve(`Claude CLI not available: ${err.message}. Falling back to graph analysis.`);
    });

    // Safety timeout
    setTimeout(() => {
      try { proc.kill(); } catch { /* ignore */ }
      if (!stdout.trim()) resolve("Request timed out. Try a more specific question.");
    }, 35000);
  });
}

export async function serveDashboard(
  projectDir: string,
  pluginDir: string,
): Promise<ServeDashboardOutput> {
  // Deploy first — generates fresh graph and builds the HTML
  const deployResult = await deployDashboard(projectDir, pluginDir);

  // If already running, return existing URL + deploy info
  if (activeServer?.listening) {
    const addr = activeServer.address();
    if (addr && typeof addr === "object") {
      return {
        ...deployResult,
        url: `http://localhost:${addr.port}`,
        port: addr.port,
        message: `${deployResult.message} Dashboard serving at http://localhost:${addr.port}`,
      };
    }
  }

  const dashboardPath = join(projectDir, ".canon", "dashboard.html");

  // Pre-build graph context once for the ask endpoint
  let graphContext: string | null = null;

  const server = createServer(async (req, res) => {
    // CORS for local dev
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || "/", `http://localhost`);

    try {
      // Serve dashboard
      if (url.pathname === "/" || url.pathname === "/index.html") {
        const html = await readFile(dashboardPath, "utf-8");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }

      // API: ask codebase — pipes through claude CLI
      if (url.pathname === "/api/ask" && req.method === "POST") {
        const body = await readBody(req);
        const input = JSON.parse(body);
        const question = input.question || "";

        // Build graph context on first request (lazy)
        if (!graphContext) {
          graphContext = await buildGraphContext(projectDir);
        }

        // Call Claude CLI
        const answer = await askClaude(question, graphContext, projectDir);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ answer, focus: "claude", relevant_files: [] }));
        return;
      }

      // API: get file context
      if (url.pathname === "/api/file" && req.method === "GET") {
        const filePath = url.searchParams.get("path");
        if (!filePath) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Missing path parameter" }));
          return;
        }

        // Security: prevent path traversal
        const normalized = normalize(filePath);
        if (normalized.startsWith("..") || normalized.startsWith("/")) {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Path traversal not allowed" }));
          return;
        }

        const result = await getFileContext({ file_path: normalized }, projectDir);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
        return;
      }

      // API: current git branch
      if (url.pathname === "/api/branch" && req.method === "GET") {
        const branch = await gitCurrentBranch(projectDir);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ branch }));
        return;
      }

      // 404
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
    }
  });

  // Find an open port starting from 4567
  const port = await findOpenPort(server, 4567);

  activeServer = server;

  return {
    ...deployResult,
    url: `http://localhost:${port}`,
    port,
    message: `${deployResult.message} Serving at http://localhost:${port} with live API.`,
  };
}

function readBody(req: import("http").IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

async function findOpenPort(server: Server, startPort: number): Promise<number> {
  for (let port = startPort; port < startPort + 100; port++) {
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
      return port;
    } catch {
      // port in use, try next
    }
  }
  throw new Error("Could not find an open port");
}

function gitCurrentBranch(cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd }, (err, stdout) => {
      if (err) { resolve(null); return; }
      resolve(stdout.trim() || null);
    });
  });
}
