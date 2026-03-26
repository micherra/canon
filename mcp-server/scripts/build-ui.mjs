#!/usr/bin/env node
import { readdirSync } from "fs";
import { execSync } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const uiDir = join(root, "ui");

const htmlFiles = readdirSync(uiDir).filter((f) => f.endsWith(".html"));

if (htmlFiles.length === 0) {
  console.log("No UI HTML files found in ui/");
  process.exit(0);
}

console.log(`Building ${htmlFiles.length} UIs...`);

for (const file of htmlFiles) {
  const input = `ui/${file}`;
  console.log(`  ${input}`);
  execSync(`npx vite build`, {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, INPUT: input },
  });
}

console.log("All UIs built.");
