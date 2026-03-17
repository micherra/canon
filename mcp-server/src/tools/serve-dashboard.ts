/** Canon dashboard — deploys the HTML and serves it with live API endpoints. */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from "http";
import { execFile, spawn } from "child_process";
import { readFile } from "fs/promises";
import { join, normalize } from "path";
import { deployDashboard } from "./deploy-dashboard.js";
import { getFileContext } from "./get-file-context.js";

let activeServer: Server | null = null;

const MAX_BODY_BYTES = 64 * 1024; // 64 KB
const MAX_QUESTION_LENGTH = 2000;
const MAX_HISTORY_ENTRIES = 20;
const MAX_HISTORY_CONTENT_LENGTH = 4000;
const VALID_ROLES = new Set(["user", "assistant"]);
const CLI_TIMEOUT_MS = 35000;

export interface ServeDashboardOutput {
  deployed: boolean;
  dashboard_path: string;
  url: string;
  port: number;
  message: string;
  unsummarized_files: string[];
}

interface HistoryEntry {
  role: "user" | "assistant";
  content: string;
}

// --- Input validation (validate-at-trust-boundaries) ---

function parseAskInput(body: string): { question: string; history: HistoryEntry[] } {
  const input = JSON.parse(body);

  const question = typeof input.question === "string"
    ? input.question.slice(0, MAX_QUESTION_LENGTH).trim()
    : "";
  if (!question) throw new Error("Missing or empty question");

  const history: HistoryEntry[] = [];
  if (Array.isArray(input.history)) {
    for (const entry of input.history.slice(-MAX_HISTORY_ENTRIES)) {
      if (
        entry && typeof entry === "object" &&
        typeof entry.role === "string" && VALID_ROLES.has(entry.role) &&
        typeof entry.content === "string"
      ) {
        history.push({
          role: entry.role as "user" | "assistant",
          content: entry.content.slice(0, MAX_HISTORY_CONTENT_LENGTH),
        });
      }
    }
  }

  return { question, history };
}

// --- Graph context ---

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
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return "No codebase graph data available.";
    }
    throw err;
  }
}

// --- Claude CLI interaction (consistent-abstraction-levels) ---

function buildAskPrompt(question: string, graphContext: string, history: HistoryEntry[]): { systemPrompt: string; userPrompt: string } {
  const systemPrompt = [
    "You are an expert on this codebase. Answer questions about the architecture, files, dependencies, and patterns.",
    "The user is asking from a codebase visualization dashboard. Treat short queries as questions about the codebase.",
    "For example, 'Layer violations' means 'What are the layer violations in this codebase?'",
    "Be concise but thorough. Reference specific file names when relevant.",
    "Use markdown formatting: **bold** for file names, `code` for code terms, bullet lists for multiple items.",
    "IMPORTANT: Answer directly using ONLY the codebase context below. Do NOT use any tools.",
    "",
    "Here is the codebase context:",
    graphContext,
  ].join("\n");

  let userPrompt = question;
  if (history.length > 1) {
    const prior = history.slice(0, -1);
    const convoLines = prior.map(m =>
      `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`
    ).join("\n\n");
    userPrompt = `Previous conversation:\n${convoLines}\n\nCurrent question: ${question}`;
  }

  return { systemPrompt, userPrompt };
}

function runClaudeCliPrint(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve) => {
    const proc = spawn("claude", args, {
      cwd,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30000,
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    proc.on("close", (code) => {
      const out = stdout.trim();
      const err = stderr.trim();
      if (out) {
        resolve(out);
      } else if (code === 0) {
        resolve(err || "No response generated. Try rephrasing your question.");
      } else {
        resolve(`Error (exit ${code}): ${err || "Unknown error. Try again."}`);
      }
    });

    proc.on("error", (err) => {
      resolve(`Claude CLI not available: ${err.message}. Falling back to graph analysis.`);
    });

    setTimeout(() => {
      try { proc.kill(); } catch { /* ignore */ }
      if (!stdout.trim()) resolve("Request timed out. Try a more specific question.");
    }, CLI_TIMEOUT_MS);
  });
}

function askClaude(question: string, graphContext: string, projectDir: string, history: HistoryEntry[]): Promise<string> {
  const { systemPrompt, userPrompt } = buildAskPrompt(question, graphContext, history);
  return runClaudeCliPrint([
    "--print",
    "--system-prompt", systemPrompt,
    "--max-turns", "1",
    "--model", "claude-haiku-4-5-20251001",
    userPrompt,
  ], projectDir);
}

// --- Route handlers (thin-handlers) ---

async function handleDashboard(_req: IncomingMessage, res: ServerResponse, dashboardPath: string): Promise<void> {
  const html = await readFile(dashboardPath, "utf-8");
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

async function handleAsk(
  req: IncomingMessage, res: ServerResponse,
  projectDir: string, getGraphContext: () => Promise<string>,
): Promise<void> {
  const body = await readBody(req);
  const { question, history } = parseAskInput(body);

  const graphContext = await getGraphContext();
  const answer = await askClaude(question, graphContext, projectDir, history);

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ answer, focus: "claude", relevant_files: [] }));
}

async function handleFile(url: URL, res: ServerResponse, projectDir: string): Promise<void> {
  const filePath = url.searchParams.get("path");
  if (!filePath) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Missing path parameter" }));
    return;
  }

  const normalized = normalize(filePath);
  if (normalized.startsWith("..") || normalized.startsWith("/")) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Path traversal not allowed" }));
    return;
  }

  const result = await getFileContext({ file_path: normalized }, projectDir);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(result));
}

async function handleBranch(res: ServerResponse, projectDir: string): Promise<void> {
  const branch = await gitCurrentBranch(projectDir);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ branch }));
}

// --- Server ---

export async function serveDashboard(
  projectDir: string,
  pluginDir: string,
): Promise<ServeDashboardOutput> {
  const deployResult = await deployDashboard(projectDir, pluginDir);

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

  let graphContext: string | null = null;
  async function getGraphContext(): Promise<string> {
    if (!graphContext) graphContext = await buildGraphContext(projectDir);
    return graphContext;
  }

  const server = createServer(async (req, res) => {
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
      if (url.pathname === "/" || url.pathname === "/index.html") {
        return await handleDashboard(req, res, dashboardPath);
      }
      if (url.pathname === "/api/ask" && req.method === "POST") {
        return await handleAsk(req, res, projectDir, getGraphContext);
      }
      if (url.pathname === "/api/file" && req.method === "GET") {
        return await handleFile(url, res, projectDir);
      }
      if (url.pathname === "/api/branch" && req.method === "GET") {
        return await handleBranch(res, projectDir);
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
    }
  });

  const port = await findOpenPort(server, 4567);
  activeServer = server;

  return {
    ...deployResult,
    url: `http://localhost:${port}`,
    port,
    message: `${deployResult.message} Serving at http://localhost:${port} with live API.`,
  };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      chunks.push(chunk);
    });
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
