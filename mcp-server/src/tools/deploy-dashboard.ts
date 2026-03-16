/** Canon Dashboard Deployment — copies UI files to project .canon/dashboard/ */

import { readdir, readFile, writeFile, mkdir } from "fs/promises";
import { join, dirname } from "path";

interface DeployDashboardOutput {
  deployed: boolean;
  dashboard_path: string;
  files_copied: number;
  serve_hint: string;
}

async function copyDir(src: string, dest: string): Promise<number> {
  let count = 0;
  await mkdir(dest, { recursive: true });

  const entries = await readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);
    if (entry.isDirectory()) {
      count += await copyDir(srcPath, destPath);
    } else {
      const content = await readFile(srcPath);
      await writeFile(destPath, content);
      count++;
    }
  }
  return count;
}

export async function deployDashboard(
  projectDir: string,
  pluginDir: string,
): Promise<DeployDashboardOutput> {
  const uiSrc = join(pluginDir, "ui");
  const dashboardDest = join(projectDir, ".canon", "dashboard");

  let filesCopied: number;
  try {
    filesCopied = await copyDir(uiSrc, dashboardDest);
  } catch (err) {
    return {
      deployed: false,
      dashboard_path: dashboardDest,
      files_copied: 0,
      serve_hint: `Failed to deploy: ${err}`,
    };
  }

  return {
    deployed: true,
    dashboard_path: join(dashboardDest, "index.html"),
    files_copied: filesCopied,
    serve_hint: `To view: cd "${dirname(dashboardDest)}" && python3 -m http.server 8080, then open http://localhost:8080/dashboard/`,
  };
}
