/**
 * env.ts — environment detection utility tests
 *
 * Tests cover:
 * - isSyncMode() returns true when CANON_SYNC_JOBS=1
 * - isSyncMode() returns true when CANON_SYNC_JOBS=true
 * - isSyncMode() returns false when CANON_SYNC_JOBS=0 even with CI=true
 * - isSyncMode() returns false when CANON_SYNC_JOBS=false even with CI=true
 * - isSyncMode() returns true when CI=true and no CANON_SYNC_JOBS override
 * - isSyncMode() returns true when CI=1 and no CANON_SYNC_JOBS override
 * - isSyncMode() returns false when neither CI nor CANON_SYNC_JOBS is set
 * - isCI() returns true when CI=true
 * - isCI() returns true when CI=1
 * - isCI() returns true when CI is set to any value (presence check)
 * - isCI() returns false when CI is not set
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { isSyncMode, isCI } from '../env.ts';

// ---------------------------------------------------------------------------
// Helper — clean environment for each test
// ---------------------------------------------------------------------------

const WATCHED_VARS = ['CI', 'CANON_SYNC_JOBS'];

function clearWatchedVars() {
  for (const v of WATCHED_VARS) {
    delete process.env[v];
  }
}

beforeEach(clearWatchedVars);
afterEach(clearWatchedVars);

// ---------------------------------------------------------------------------
// isCI()
// ---------------------------------------------------------------------------

describe('isCI()', () => {
  test('returns true when CI=true', () => {
    process.env.CI = 'true';
    expect(isCI()).toBe(true);
  });

  test('returns true when CI=1', () => {
    process.env.CI = '1';
    expect(isCI()).toBe(true);
  });

  test('returns true when CI is set to any non-undefined value', () => {
    process.env.CI = 'yes';
    expect(isCI()).toBe(true);
  });

  test('returns false when CI is not set', () => {
    expect(isCI()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isSyncMode() — CANON_SYNC_JOBS takes precedence
// ---------------------------------------------------------------------------

describe('isSyncMode() — CANON_SYNC_JOBS override', () => {
  test('returns true when CANON_SYNC_JOBS=1', () => {
    process.env.CANON_SYNC_JOBS = '1';
    expect(isSyncMode()).toBe(true);
  });

  test('returns true when CANON_SYNC_JOBS=true', () => {
    process.env.CANON_SYNC_JOBS = 'true';
    expect(isSyncMode()).toBe(true);
  });

  test('returns false when CANON_SYNC_JOBS=0, even with CI=true', () => {
    process.env.CANON_SYNC_JOBS = '0';
    process.env.CI = 'true';
    expect(isSyncMode()).toBe(false);
  });

  test('returns false when CANON_SYNC_JOBS=false, even with CI=true', () => {
    process.env.CANON_SYNC_JOBS = 'false';
    process.env.CI = 'true';
    expect(isSyncMode()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isSyncMode() — CI fallback when CANON_SYNC_JOBS not set
// ---------------------------------------------------------------------------

describe('isSyncMode() — CI fallback', () => {
  test('returns true when CI=true and no CANON_SYNC_JOBS', () => {
    process.env.CI = 'true';
    expect(isSyncMode()).toBe(true);
  });

  test('returns true when CI=1 and no CANON_SYNC_JOBS', () => {
    process.env.CI = '1';
    expect(isSyncMode()).toBe(true);
  });

  test('returns false when neither CI nor CANON_SYNC_JOBS is set', () => {
    expect(isSyncMode()).toBe(false);
  });
});
