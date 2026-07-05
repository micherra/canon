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
          // compute-autonomy-tier instantiates DriftDb here and passes it as DriftDbAdapter —
          // deferred DI exception until a DI container is wired
          "^src/features/orchestration/tools/compute-autonomy-tier\\.ts$",
          // reconcile-workspace writes cliff events to drift.db (fail-open write-through, decision cliff-d2) —
          // deferred DI exception until a DI container is wired
          "^src/features/orchestration/tools/reconcile-workspace\\.ts$",
          // active-workspaces registry (drift.db, Inc 0 event-backbone-explore): active-workspace-registration
          // registers on behalf of init-workspace (fail-open), janitor tombstones on reap (fail-open),
          // post_message/tail_messages/list_active_workspaces read/gate on the registry —
          // deferred DI exception until a DI container is wired
          "^src/features/orchestration/services/active-workspace-registration\\.ts$",
          "^src/features/orchestration/services/janitor\\.ts$",
          "^src/features/orchestration/tools/post-message\\.ts$",
          "^src/features/orchestration/tools/tail-messages\\.ts$",
          "^src/features/orchestration/tools/list-active-workspaces\\.ts$",
          // Relocated from diagnostics (ADR-0006): pitfall-enrichment, hot-file-detection, area-memory-enrichment
          // query drift.db directly — deferred DI exception until a DI container is wired
          "^src/features/orchestration/services/pitfall-enrichment\\.ts$",
          "^src/features/orchestration/services/hot-file-detection\\.ts$",
          "^src/features/orchestration/services/area-memory-enrichment\\.ts$",
          // ADR-0038: decision-persistence mirrors a reaped workspace's decision events
          // into drift.db orchestrator_decisions, called by janitor.ts (already excepted
          // above) at the reap-time destruction boundary — deferred DI exception until a
          // DI container is wired
          "^src/features/orchestration/services/decision-persistence\\.ts$",
          // ADR-0038: decisions-corpus reads the durable orchestrator_decisions table
          // (getDriftDb(...).getOrchestratorDecisions().getAll()) for the offline
          // cross-workspace reader/aggregator — deferred DI exception until a DI
          // container is wired
          "^src/features/orchestration/services/decisions-corpus\\.ts$",
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
    {
      name: "no-cross-feature-internal-import",
      comment:
        "A feature must not import another feature's internals — share contracts via @domains/* types, " +
        "a single named public entry, or a sanctioned foundational layer (@shared/*, @domains/*, @platform/*, @app/*). " +
        "Enforces the per-folder-public-interface convention. The $1 back-reference excludes same-feature imports. " +
        "ALLOWANCE: knowledge-graph is a foundational read service (freshness/query/git-intel over the @graph/ engine) " +
        "that peer features legitimately depend on — see docs/adr/0005-knowledge-graph-is-a-foundational-service.md. " +
        "This is the ONLY feature-target allowance; all other former cross-feature edges were relocated (ADR-0006).",
      severity: "error",
      from: {
        path: "^src/features/([^/]+)/",
        pathNot: ["__tests__/", "\\.test\\.ts$"],
      },
      to: {
        path: "^src/features/([^/]+)/",
        pathNot: [
          // Self-exclusion — MUST be first. $1 = the source feature from from.path.
          "^src/features/$1/",
          // ADR-0005: knowledge-graph is a foundational service features may depend on.
          "^src/features/knowledge-graph/",
        ],
      },
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
