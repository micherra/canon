/**
 * drive-flow-types — Zod schema validation tests
 *
 * Tests that DriveFlowInput Zod schema accepts valid inputs and rejects invalid ones.
 */

import { describe, test, expect } from 'vitest';
import { DriveFlowInputSchema } from '../orchestration/drive-flow-types.ts';
import type { DriveFlowAction, SpawnRequest, HitlBreakpoint } from '../orchestration/drive-flow-types.ts';

// Minimal ResolvedFlow for testing
const MINIMAL_FLOW = {
  name: 'test-flow',
  description: 'test',
  entry: 'start',
  spawn_instructions: { start: 'Do the thing' },
  states: {
    start: { type: 'single' as const, agent: 'agent-a', transitions: { done: 'end' } },
    end: { type: 'terminal' as const },
  },
};

describe('DriveFlowInputSchema', () => {
  test('accepts valid minimal input (workspace + flow only)', () => {
    const result = DriveFlowInputSchema.safeParse({
      workspace: '/some/workspace',
      flow: MINIMAL_FLOW,
    });
    expect(result.success).toBe(true);
  });

  test('accepts valid input with result', () => {
    const result = DriveFlowInputSchema.safeParse({
      workspace: '/some/workspace',
      flow: MINIMAL_FLOW,
      result: {
        state_id: 'start',
        status: 'done',
        artifacts: ['path/to/file.ts'],
        agent_session_id: 'sess_abc123',
      },
    });
    expect(result.success).toBe(true);
  });

  test('accepts result with parallel_results', () => {
    const result = DriveFlowInputSchema.safeParse({
      workspace: '/some/workspace',
      flow: MINIMAL_FLOW,
      result: {
        state_id: 'start',
        status: 'done',
        parallel_results: [
          { item: 'task-01', status: 'done', artifacts: ['file.ts'] },
          { item: 'task-02', status: 'done_with_concerns' },
        ],
      },
    });
    expect(result.success).toBe(true);
  });

  test('accepts result with metrics', () => {
    const result = DriveFlowInputSchema.safeParse({
      workspace: '/some/workspace',
      flow: MINIMAL_FLOW,
      result: {
        state_id: 'start',
        status: 'done',
        metrics: { tool_calls: 10, turns: 5 },
      },
    });
    expect(result.success).toBe(true);
  });

  test('rejects missing workspace', () => {
    const result = DriveFlowInputSchema.safeParse({
      flow: MINIMAL_FLOW,
    });
    expect(result.success).toBe(false);
  });

  test('rejects missing flow', () => {
    const result = DriveFlowInputSchema.safeParse({
      workspace: '/some/workspace',
    });
    expect(result.success).toBe(false);
  });

  test('rejects empty string workspace', () => {
    const result = DriveFlowInputSchema.safeParse({
      workspace: '',
      flow: MINIMAL_FLOW,
    });
    expect(result.success).toBe(false);
  });

  test('result is optional (omitting it is valid)', () => {
    const result = DriveFlowInputSchema.safeParse({
      workspace: '/workspace',
      flow: MINIMAL_FLOW,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.result).toBeUndefined();
    }
  });
});

describe('DriveFlowAction discriminated union types', () => {
  test('spawn action has correct shape', () => {
    const action: DriveFlowAction = {
      action: 'spawn',
      requests: [
        {
          agent_type: 'canon:canon-implementor',
          prompt: 'Implement the feature',
          isolation: 'worktree',
          task_id: 'task-01',
        },
      ],
    };
    expect(action.action).toBe('spawn');
    expect(action.requests).toHaveLength(1);
  });

  test('hitl action has correct shape', () => {
    const action: DriveFlowAction = {
      action: 'hitl',
      breakpoint: {
        reason: 'Needs human decision',
        context: 'The PR has conflicts that need manual resolution',
        options: ['merge', 'rebase', 'abort'],
      },
    };
    expect(action.action).toBe('hitl');
    expect(action.breakpoint.options).toHaveLength(3);
  });

  test('done action has correct shape', () => {
    const action: DriveFlowAction = {
      action: 'done',
      terminal_state: 'complete',
      summary: 'All tasks completed successfully',
    };
    expect(action.action).toBe('done');
    expect(action.terminal_state).toBe('complete');
  });

  test('SpawnRequest supports continue_from', () => {
    const request: SpawnRequest = {
      agent_type: 'canon:canon-fixer',
      prompt: 'Fix the test failures',
      isolation: 'none',
      continue_from: {
        agent_id: 'agent-123',
        context_summary: 'Previously fixed 3/5 test failures',
      },
    };
    expect(request.continue_from?.agent_id).toBe('agent-123');
  });

  test('HitlBreakpoint options field is optional', () => {
    const bp: HitlBreakpoint = {
      reason: 'Need input',
      context: 'Some context here',
    };
    expect(bp.options).toBeUndefined();
  });
});
