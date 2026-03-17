/** Canon dashboard — deploys the HTML and serves it with live API endpoints. */

import { createServer, type Server } from "http";
import { execFile } from "child_process";
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

      // API: ask codebase
      if (url.pathname === "/api/ask" && req.method === "POST") {
        const body = await readBody(req);
        const input = JSON.parse(body);
        const result = await askCodebase(input, projectDir);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
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
