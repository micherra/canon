/**
 * SQL statement preparation for ExecutionStore.
 * Extracted from execution-store.ts to keep each file under 600 lines.
 */

import type Database from "better-sqlite3";

export type ExecutionStoreStatements = {
  // Execution
  stmtInitExecution: Database.Statement;
  stmtGetExecution: Database.Statement;
  // State
  stmtUpsertState: Database.Statement;
  stmtGetState: Database.Statement;
  stmtGetAllStates: Database.Statement;
  // Iteration
  stmtUpsertIteration: Database.Statement;
  stmtGetIteration: Database.Statement;
  // Progress
  stmtAppendProgress: Database.Statement;
  stmtGetProgressAll: Database.Statement;
  stmtGetProgressLimited: Database.Statement;
  // Messages
  stmtAppendMessage: Database.Statement;
  stmtGetMessages: Database.Statement;
  stmtGetMessagesSince: Database.Statement;
  stmtGetMessagesSinceId: Database.Statement;
  stmtHasMessages: Database.Statement;
  // Events
  stmtAppendEvent: Database.Statement;
  stmtGetEventsByCorrelation: Database.Statement;
  stmtGetEventsByType: Database.Statement;
  stmtGetEventsAll: Database.Statement;
  // Iteration results
  stmtRecordIterationResult: Database.Statement;
  stmtGetLastTwoIterationResults: Database.Statement;
  // Misc
  stmtUpdateStateMetrics: Database.Statement;
  stmtSetTranscriptPath: Database.Statement;
  stmtGetTranscriptPath: Database.Statement;
  stmtUpdateAgentSession: Database.Statement;
  stmtGetAgentSession: Database.Statement;
};

function prepareExecutionAndStateStmts(db: Database.Database) {
  const stmtInitExecution = db.prepare(`
    INSERT INTO execution (
      id, flow, task, entry, current_state, base_commit,
      started, last_updated, blocked, concerns, skipped, metadata,
      branch, sanitized, created, original_task,
      tier, flow_name, slug, status, completed_at,
      rolled_back_at, rolled_back_to, correlation_id,
      worktree_path, worktree_branch
    ) VALUES (
      1, @flow, @task, @entry, @current_state, @base_commit,
      @started, @last_updated, @blocked, @concerns, @skipped, @metadata,
      @branch, @sanitized, @created, @original_task,
      @tier, @flow_name, @slug, @status, @completed_at,
      @rolled_back_at, @rolled_back_to, @correlation_id,
      @worktree_path, @worktree_branch
    )
  `);
  const stmtGetExecution = db.prepare(`SELECT * FROM execution WHERE id = 1`);

  const stmtUpsertState = db.prepare(`
    INSERT INTO execution_states (
      state_id, status, entries, entered_at, completed_at,
      result, artifacts, artifact_history, error,
      wave, wave_total, wave_results, metrics,
      gate_results, postcondition_results, discovered_gates,
      discovered_postconditions, parallel_results, compete_results, synthesized,
      inserted_return_to
    ) VALUES (
      @state_id, @status, @entries, @entered_at, @completed_at,
      @result, @artifacts, @artifact_history, @error,
      @wave, @wave_total, @wave_results, @metrics,
      @gate_results, @postcondition_results, @discovered_gates,
      @discovered_postconditions, @parallel_results, @compete_results, @synthesized,
      @inserted_return_to
    )
    ON CONFLICT(state_id) DO UPDATE SET
      status                    = excluded.status,
      entries                   = excluded.entries,
      entered_at                = excluded.entered_at,
      completed_at              = excluded.completed_at,
      result                    = excluded.result,
      artifacts                 = excluded.artifacts,
      artifact_history          = excluded.artifact_history,
      error                     = excluded.error,
      wave                      = excluded.wave,
      wave_total                = excluded.wave_total,
      wave_results              = excluded.wave_results,
      metrics                   = excluded.metrics,
      gate_results              = excluded.gate_results,
      postcondition_results     = excluded.postcondition_results,
      discovered_gates          = excluded.discovered_gates,
      discovered_postconditions = excluded.discovered_postconditions,
      parallel_results          = excluded.parallel_results,
      compete_results           = excluded.compete_results,
      synthesized               = excluded.synthesized,
      inserted_return_to        = excluded.inserted_return_to
      -- transcript_path intentionally omitted: preserves existing value on update
  `);
  const stmtGetState = db.prepare(`SELECT * FROM execution_states WHERE state_id = ?`);
  const stmtGetAllStates = db.prepare(`SELECT * FROM execution_states ORDER BY state_id`);

  return { stmtGetAllStates, stmtGetExecution, stmtGetState, stmtInitExecution, stmtUpsertState };
}

function prepareIterationAndProgressStmts(db: Database.Database) {
  const stmtUpsertIteration = db.prepare(`
    INSERT INTO iterations (state_id, count, max, history, cannot_fix)
    VALUES (@state_id, @count, @max, @history, @cannot_fix)
    ON CONFLICT(state_id) DO UPDATE SET
      count      = excluded.count,
      max        = excluded.max,
      history    = excluded.history,
      cannot_fix = excluded.cannot_fix
  `);
  const stmtGetIteration = db.prepare(`SELECT * FROM iterations WHERE state_id = ?`);
  const stmtAppendProgress = db.prepare(
    `INSERT INTO progress_entries (line, timestamp) VALUES (@line, @timestamp)`,
  );
  const stmtGetProgressAll = db.prepare(`SELECT * FROM progress_entries ORDER BY id ASC`);
  const stmtGetProgressLimited = db.prepare(`
    SELECT * FROM (
      SELECT * FROM progress_entries ORDER BY id DESC LIMIT ?
    ) ORDER BY id ASC
  `);
  return {
    stmtAppendProgress,
    stmtGetIteration,
    stmtGetProgressAll,
    stmtGetProgressLimited,
    stmtUpsertIteration,
  };
}

function prepareMessageAndEventStmts(db: Database.Database) {
  const stmtAppendMessage = db.prepare(`
    INSERT INTO messages (channel, sender, content, timestamp)
    VALUES (@channel, @sender, @content, @timestamp)
    RETURNING *
  `);
  const stmtGetMessages = db.prepare(`SELECT * FROM messages WHERE channel = ? ORDER BY id ASC`);
  const stmtGetMessagesSince = db.prepare(
    `SELECT * FROM messages WHERE channel = ? AND timestamp > ? ORDER BY id ASC`,
  );
  const stmtGetMessagesSinceId = db.prepare(
    `SELECT * FROM messages WHERE channel = ? AND id > ? ORDER BY id ASC`,
  );
  const stmtHasMessages = db.prepare(`SELECT 1 FROM messages WHERE channel = ? LIMIT 1`);

  const stmtAppendEvent = db.prepare(`
    INSERT INTO events (type, payload, correlation_id, timestamp)
    VALUES (@type, @payload, @correlation_id, @timestamp)
  `);
  const stmtGetEventsByCorrelation = db.prepare(
    `SELECT * FROM events WHERE correlation_id = ? ORDER BY id ASC`,
  );
  const stmtGetEventsByType = db.prepare(`SELECT * FROM events WHERE type = ? ORDER BY id ASC`);
  const stmtGetEventsAll = db.prepare(`SELECT * FROM events ORDER BY id ASC`);

  return {
    stmtAppendEvent,
    stmtAppendMessage,
    stmtGetEventsAll,
    stmtGetEventsByCorrelation,
    stmtGetEventsByType,
    stmtGetMessages,
    stmtGetMessagesSince,
    stmtGetMessagesSinceId,
    stmtHasMessages,
  };
}

function prepareMiscStmts(db: Database.Database) {
  const stmtRecordIterationResult = db.prepare(`
    INSERT OR REPLACE INTO iteration_results (state_id, iteration, status, data, timestamp)
    VALUES (@state_id, @iteration, @status, @data, @timestamp)
  `);
  const stmtGetLastTwoIterationResults = db.prepare(`
    SELECT status, data FROM iteration_results
    WHERE state_id = ?
    ORDER BY iteration DESC
    LIMIT 2
  `);
  const stmtUpdateStateMetrics = db.prepare(
    `UPDATE execution_states SET metrics = ? WHERE state_id = ?`,
  );
  const stmtSetTranscriptPath = db.prepare(
    `INSERT INTO execution_states (state_id, status, entries, transcript_path)
     VALUES (?, 'pending', 0, ?)
     ON CONFLICT(state_id) DO UPDATE SET transcript_path = excluded.transcript_path`,
  );
  const stmtGetTranscriptPath = db.prepare(
    `SELECT transcript_path FROM execution_states WHERE state_id = ?`,
  );
  const stmtUpdateAgentSession = db.prepare(
    `UPDATE execution_states SET agent_session_id = ?, last_agent_activity = ? WHERE state_id = ?`,
  );
  const stmtGetAgentSession = db.prepare(
    `SELECT agent_session_id, last_agent_activity FROM execution_states WHERE state_id = ?`,
  );
  return {
    stmtGetAgentSession,
    stmtGetLastTwoIterationResults,
    stmtGetTranscriptPath,
    stmtRecordIterationResult,
    stmtSetTranscriptPath,
    stmtUpdateAgentSession,
    stmtUpdateStateMetrics,
  };
}

export function prepareAllStatements(db: Database.Database): ExecutionStoreStatements {
  return {
    ...prepareExecutionAndStateStmts(db),
    ...prepareIterationAndProgressStmts(db),
    ...prepareMessageAndEventStmts(db),
    ...prepareMiscStmts(db),
  };
}
