/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "no-orchestration-to-graph-direct",
      comment:
        "Orchestration must not import directly from graph/ — use IKgStore/IKgQuery interface in domains/knowledge-graph/. " +
        "DEFERRED-DI exceptions: inject-context.ts, init-workspace.ts, and workspace-structure.ts still instantiate " +
        "KgQuery/KgStore/initDatabase directly because full DI wiring is deferred to a future task. " +
        "Remove these pathNot entries once a DI container is wired.",
      severity: "error",
      from: {
        path: "^src/features/orchestration/",
        // Exclude test files — they instantiate concrete classes for integration test setup
        // Exclude deferred-DI source files — direct graph imports remain until DI container is wired (future task)
        pathNot: [
          "^src/features/orchestration/__tests__/",
          "\\.test\\.ts$",
          "^src/features/orchestration/services/inject-context\\.ts$",
          "^src/features/orchestration/services/kg-context-formatter\\.ts$",
          "^src/features/orchestration/tools/init-workspace\\.ts$",
          "^src/features/orchestration/services/workspace-structure\\.ts$",
        ],
      },
      to: { path: "^src/graph/" },
    },
    {
      name: "no-orchestration-to-drift-direct",
      comment:
        "Orchestration must not import directly from platform/storage/drift/ — use IDriftStore interface in domains/drift/. " +
        "DEFERRED-DI exceptions: report.ts and orchestration-journal.ts still instantiate " +
        "DriftStore/appendFlowRun directly because full DI wiring is deferred to a future task. " +
        "Remove these pathNot entries once a DI container is wired.",
      severity: "error",
      from: {
        path: "^src/features/orchestration/",
        // Exclude test files — they instantiate concrete classes for integration test setup
        // Exclude deferred-DI source files — direct drift imports remain until DI container is wired (future task)
        pathNot: [
          "^src/features/orchestration/__tests__/",
          "\\.test\\.ts$",
          "^src/features/orchestration/tools/report\\.ts$",
          "^src/features/orchestration/tools/orchestration-journal\\.ts$",
          "^src/features/orchestration/services/workspace-cleanup\\.ts$",
          // ADR-016: learn-gate reads drift DB directly for flow count — deferred DI exception
          "^src/features/orchestration/services/learn-gate\\.ts$",
          // MP-7: build-trend-summary-writer reads drift DB directly — deferred DI exception
          "^src/features/orchestration/services/build-trend-summary-writer\\.ts$",
        ],
      },
      to: { path: "^src/platform/storage/drift/" },
    },
    {
      name: "no-flows-to-orchestration",
      comment:
        "Flows context must not depend on orchestration features. " +
        "Test files are excluded: flow-schema-approval.test.ts imports ApprovalBreakpoint/DriveFlowAction from " +
        "drive-flow-types.ts for compile-time checks — those types should move to domains/flows/ in a future task.",
      severity: "error",
      from: {
        path: "^src/domains/flows/",
        // Exclude test files — they may import types from orchestration for compile-time checks
        pathNot: [
          "^src/domains/flows/__tests__/",
          "\\.test\\.ts$",
        ],
      },
      to: { path: "^src/features/orchestration/" },
    },
    {
      name: "no-graph-to-orchestration",
      comment: "Knowledge Graph context must not depend on orchestration features",
      severity: "error",
      from: { path: "^src/graph/" },
      to: { path: "^src/features/orchestration/" },
    },
    {
      name: "no-drift-to-orchestration",
      comment: "Drift context must not depend on orchestration features",
      severity: "error",
      from: { path: "^src/platform/storage/drift/" },
      to: { path: "^src/features/orchestration/" },
    },
  ],
  options: {
    doNotFollow: {
      path: "node_modules",
    },
    tsPreCompilationDeps: true,
    tsConfig: {
      fileName: "tsconfig.json",
    },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default"],
    },
    reporterOptions: {
      text: {
        highlightFocused: true,
      },
    },
    // Exclude legacy test directory from analysis
    exclude: {
      path: "src/orchestration/__tests__/",
    },
  },
};
