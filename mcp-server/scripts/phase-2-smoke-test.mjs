#!/usr/bin/env node
/**
 * Phase 2 smoke test harness.
 *
 * Loads every runbook under skills/canon/runbooks/, plans each against a
 * disposable workspace, writes the hook state files, simulates artifact
 * creation for every descriptor (including wave-expanded ones with
 * synthetic task ids), and prints per-runbook trees.
 *
 * Scope matches the Phase 1 harness (scripts/phase-1-smoke-test.mjs):
 *   - No live Claude Code team execution; pure planner + state writer
 *     exercise.
 *   - No persistent side effects outside $TMPDIR.
 *   - Advisory-only — read-only against the runbooks, write-only inside
 *     a temp workspace tree.
 *
 * The Phase 1 harness is left untouched; this script is strictly
 * additive per the Phase 2 migration policy.
 */

import { mkdirSync, readFileSync, readdirSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const here = new URL(".", import.meta.url).pathname;
const pluginDir = resolve(here, "..", "..");
const mcpDir = resolve(here, "..");

// Gate on the feature flag explicitly so the planner refuses to run
// when the environment is off — this mirrors the real enforcement path.
process.env.CANON_AGENT_TEAMS_MODE = "on";

const { loadAndPlan, writeTaskArtifactState, deriveTaskListId } = await import(
  pathToFileURL(
    join(mcpDir, "src", "features", "orchestration", "lead-mode.ts"),
  ).href
);

/**
 * Every runbook + its expected plan shape. The fixture wave_context is
 * seeded with three synthetic task ids so wave expansion × 3 is visible
 * in the output tree.
 */
const RUNBOOKS = [
  { name: "fast-path", waves: false, expectedCount: 4 },
  { name: "feature", waves: true, expectedCount: 7 + 2 }, // 7 steps + 2 extra wave expansions (3 implementors vs 1)
  { name: "refactor", waves: true, expectedCount: 7 + 2 },
  { name: "migrate", waves: true, expectedCount: 8 + 2 },
  { name: "test-gap", waves: false, expectedCount: 3 },
  { name: "review-only", waves: false, expectedCount: 1 },
  { name: "security-audit", waves: false, expectedCount: 2 },
];

const FIXTURE_WAVE_CONTEXT = {
  slug: "fix-search-bug",
  task_ids: ["t1", "t2", "t3"],
};

const FIXTURE_TARGETS = ["src/example.ts", "src/example.test.ts"];

function walk(dir, prefix = "") {
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    console.log(`${prefix}${entry.name}${entry.isDirectory() ? "/" : ""}`);
    if (entry.isDirectory()) walk(join(dir, entry.name), prefix + "  ");
  }
}

function mkWorkspace(label) {
  const dir = mkdtempSync(join(tmpdir(), `canon-phase-2-${label}-`));
  for (const sub of ["research", "plans", "reviews", "decisions"]) {
    mkdirSync(join(dir, sub), { recursive: true });
  }
  writeFileSync(join(dir, "progress.md"), `## Progress: Phase 2 smoke — ${label}\n`);
  return dir;
}

function simulateArtifactCreation(workspaceDir, descriptors) {
  for (const d of descriptors) {
    const p = join(workspaceDir, d.artifact_path);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(
      p,
      `# ${d.role} artifact — ${d.task_id}\n\nsimulated for phase-2 smoke test\n`,
    );
  }
}

let failed = 0;
const summary = [];

console.log("=== Phase 2 smoke test ===");
console.log("plugin_dir:", pluginDir);
console.log();

for (const entry of RUNBOOKS) {
  const { name, waves, expectedCount } = entry;
  const workspaceId = `phase-2-${name}`;
  const workspaceDir = mkWorkspace(name);

  console.log(`--- runbook: ${name} ---`);
  console.log(`workspace_dir: ${workspaceDir}`);
  console.log(`task_list_id:  ${deriveTaskListId(workspaceId)}`);

  try {
    const planInput = {
      workspace_id: workspaceId,
      target_files: FIXTURE_TARGETS,
      ...(waves ? { wave_context: FIXTURE_WAVE_CONTEXT } : {}),
    };
    const { runbook, descriptors } = await loadAndPlan(pluginDir, name, planInput);

    console.log(
      `loaded: ${runbook.name} (${runbook.tier}); steps=${runbook.steps.length}; descriptors=${descriptors.length}${waves ? " (wave expanded × " + FIXTURE_WAVE_CONTEXT.task_ids.length + ")" : ""}`,
    );
    if (descriptors.length !== expectedCount) {
      console.log(
        `WARN: expected ${expectedCount} descriptors, got ${descriptors.length}`,
      );
    }
    for (const d of descriptors) {
      const tag = d.wave_context ? " [wave]" : "";
      console.log(
        `  - ${d.task_id}  ${d.role}  → ${d.artifact_path}${tag}  hitl=${d.hitl}`,
      );
    }

    const paths = writeTaskArtifactState(workspaceDir, descriptors);
    console.log(`  state files:`);
    console.log(`    ${paths.task_state_path}`);
    console.log(`    ${paths.teammate_state_path}`);

    simulateArtifactCreation(workspaceDir, descriptors);

    console.log(`  workspace tree:`);
    walk(workspaceDir, "    ");

    summary.push({
      name,
      descriptors: descriptors.length,
      waveExpanded: waves,
      workspaceDir,
    });
    console.log();
  } catch (e) {
    failed++;
    console.log(`ERR ${name}: ${e instanceof Error ? e.message : String(e)}`);
    if (e instanceof Error && e.stack) {
      console.log(e.stack.split("\n").slice(1, 4).map((l) => "    " + l).join("\n"));
    }
    console.log();
  }
}

console.log("=== summary ===");
for (const s of summary) {
  console.log(
    `  ${s.name.padEnd(16)} descriptors=${s.descriptors}  wave=${s.waveExpanded}`,
  );
}
console.log();
if (failed === 0) {
  console.log(`OK — ${summary.length}/${RUNBOOKS.length} runbooks planned and wrote state cleanly.`);
  process.exit(0);
} else {
  console.log(`FAIL — ${failed} runbook(s) errored.`);
  process.exit(1);
}
