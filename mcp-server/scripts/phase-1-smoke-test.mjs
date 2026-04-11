#!/usr/bin/env node
/**
 * Phase 1 smoke test harness.
 *
 * Invokes the Canon lead-mode planner against the real
 * skills/canon/runbooks/fast-path.yaml under a temporary workspace and
 * prints:
 *   - the descriptor list
 *   - the first spawn prompt (for visual inspection)
 *   - the state files written under agent-teams/
 *
 * This is a foundation-level smoke test. It does NOT spin up a live
 * Claude Code team — that validation requires a Claude Code v2.1.32+
 * session with CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1, which is
 * deferred to the Phase 1 handoff environment.
 */

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Resolve the plugin root: this script lives at
// mcp-server/scripts/phase-1-smoke-test.mjs, so the plugin root is two
// levels up.
const here = new URL(".", import.meta.url).pathname;
const pluginDir = resolve(here, "..", "..");
const mcpDir = resolve(here, "..");

// Import the compiled lead-mode module via tsx's runtime transpile.
// Requires: `npx tsx scripts/phase-1-smoke-test.mjs` from mcp-server/.
process.env.CANON_AGENT_TEAMS_MODE = "on";

const {
  deriveTaskListId,
  filterPendingDescriptors,
  loadAndPlan,
  writeTaskArtifactState,
} = await import(
  pathToFileURL(
    join(mcpDir, "src", "features", "orchestration", "lead-mode.ts"),
  ).href
);

const { summarizeTaskList } = await import(
  pathToFileURL(
    join(mcpDir, "src", "domains", "task-list", "index.ts"),
  ).href
);

const workspaceId = "phase-1-smoke";
const workspaceDir = mkdtempSync(join(tmpdir(), `canon-${workspaceId}-`));
// Seed the workspace directory structure the way init_workspace would.
for (const sub of ["research", "plans", "reviews", "decisions"]) {
  mkdirSync(join(workspaceDir, sub), { recursive: true });
}
writeFileSync(
  join(workspaceDir, "progress.md"),
  "## Progress: Phase 1 smoke test\n",
);

console.log("=== Phase 1 smoke test ===");
console.log("plugin_dir:", pluginDir);
console.log("workspace_dir:", workspaceDir);
console.log("task_list_id:", deriveTaskListId(workspaceId));
console.log();

const { runbook, descriptors } = await loadAndPlan(pluginDir, "fast-path", {
  workspace_id: workspaceId,
  target_files: ["src/example.ts", "src/example.test.ts"],
});

console.log(`loaded runbook: ${runbook.name} (${runbook.tier})`);
console.log(`descriptors: ${descriptors.length}`);
for (const d of descriptors) {
  console.log(
    `  - ${d.task_id}  role=${d.role}  artifact=${d.artifact}  hitl=${d.hitl}`,
  );
}
console.log();

const paths = writeTaskArtifactState(workspaceDir, descriptors);
console.log("wrote state files:");
console.log(`  ${paths.task_state_path}`);
console.log(`  ${paths.teammate_state_path}`);
console.log();

console.log("--- first spawn prompt preview ---");
console.log(descriptors[0].spawn_prompt);
console.log("--- end preview ---");
console.log();

console.log("--- task-artifacts.json ---");
console.log(readFileSync(paths.task_state_path, "utf8"));
console.log();

console.log("--- teammate-artifacts.json ---");
console.log(readFileSync(paths.teammate_state_path, "utf8"));
console.log();

// Validate: simulate artifact creation then re-check presence to show
// the hook state file has the right keys.
console.log("--- simulated artifact creation ---");
for (const d of descriptors) {
  const p = join(workspaceDir, d.artifact_path);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, `# ${d.role} artifact\n\nsimulated for smoke test\n`);
  console.log(`  wrote ${d.artifact_path}`);
}
console.log();

console.log("--- workspace tree ---");
function walk(dir, prefix = "") {
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    console.log(`${prefix}${entry.name}${entry.isDirectory() ? "/" : ""}`);
    if (entry.isDirectory()) walk(join(dir, entry.name), prefix + "  ");
  }
}
walk(workspaceDir);
console.log();

// Task-list exercise: wire the Claude Code task list into the smoke
// test so summarizeTaskList / filterPendingDescriptors get real
// end-to-end coverage outside of unit tests. Uses an override
// `tasks_root` pointing into the workspace so we never touch the real
// ~/.claude/tasks directory.
console.log("--- task-list exercise ---");
const taskListId = deriveTaskListId(workspaceId);
const tasksRoot = join(workspaceDir, "fake-tasks-root");
mkdirSync(join(tasksRoot, taskListId), { recursive: true });

// Stage 1: every descriptor pending.
for (const d of descriptors) {
  writeFileSync(
    join(tasksRoot, taskListId, `${d.task_id}.json`),
    JSON.stringify(
      {
        active_form: `Running ${d.role}`,
        content: `${d.role} step for ${runbook.name}`,
        id: d.task_id,
        status: "pending",
      },
      null,
      2,
    ),
  );
}

const stage1Summary = summarizeTaskList({
  task_list_id: taskListId,
  tasks_root: tasksRoot,
});
console.log("stage 1 (all pending):");
console.log(`  total: ${stage1Summary.total}`);
console.log(`  by_status: ${JSON.stringify(stage1Summary.by_status)}`);
console.log(`  path: ${stage1Summary.path}`);
const stage1Pending = filterPendingDescriptors(descriptors, {
  task_list_id: taskListId,
  tasks_root: tasksRoot,
});
console.log(`  filterPendingDescriptors: ${stage1Pending.length} pending`);

// Stage 2: mark the first two descriptors completed (researcher +
// architect), leaving implementor and reviewer pending. This simulates
// a mid-run resume from a previous session.
for (const d of descriptors.slice(0, 2)) {
  writeFileSync(
    join(tasksRoot, taskListId, `${d.task_id}.json`),
    JSON.stringify(
      {
        active_form: `Completed ${d.role}`,
        content: `${d.role} step for ${runbook.name}`,
        id: d.task_id,
        status: "completed",
      },
      null,
      2,
    ),
  );
}

const stage2Summary = summarizeTaskList({
  task_list_id: taskListId,
  tasks_root: tasksRoot,
});
console.log();
console.log("stage 2 (first two completed — simulating resume):");
console.log(`  total: ${stage2Summary.total}`);
console.log(`  by_status: ${JSON.stringify(stage2Summary.by_status)}`);
const stage2Pending = filterPendingDescriptors(descriptors, {
  task_list_id: taskListId,
  tasks_root: tasksRoot,
});
console.log(
  `  filterPendingDescriptors: ${stage2Pending.length} pending — ${stage2Pending.map((d) => d.role).join(", ")}`,
);

console.log();
console.log("OK");
