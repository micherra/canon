/**
 * KG dependency factory.
 *
 * Provides a single factory function that creates IKgQuery / IKgStore
 * instances from a better-sqlite3 Database handle.  Callers in
 * features/orchestration/ import this factory rather than directly importing
 * the concrete KgQuery / KgStore classes from @graph/, keeping the
 * orchestration context free of direct graph/ dependencies.
 *
 * Canon: bounded-context-boundaries — orchestration context imports this
 * factory from features/knowledge-graph/ (allowed) instead of directly
 * importing from graph/ (forbidden by dep-cruiser rule).
 * Canon: information-hiding — concrete KgQuery/KgStore classes are hidden
 * behind the IKgQuery/IKgStore interfaces returned by this factory.
 */

import type { IKgQuery, IKgStore } from "@domains/knowledge-graph/kg-store.interface.ts";
import { KgQuery } from "@graph/kg-query.ts";
import { KgStore } from "@graph/kg-store.ts";
import type Database from "better-sqlite3";

/**
 * Create IKgQuery and IKgStore instances from an open SQLite database handle.
 *
 * @param db - An open better-sqlite3 Database handle (caller owns the lifecycle)
 * @returns Object containing an IKgQuery and an IKgStore bound to the same DB
 */
export function createKgDependencies(db: Database.Database): {
  kgQuery: IKgQuery;
  kgStore: IKgStore;
} {
  return {
    kgQuery: new KgQuery(db),
    kgStore: new KgStore(db),
  };
}
