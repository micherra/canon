/**
 * Fail-open write-through of a newly created/resumed workspace to the
 * project-level active-workspaces registry (drift.db, v12).
 *
 * Extracted from init-workspace.ts to keep that file under the 600-line limit.
 *
 * Types here are deliberately self-contained (not imported from
 * init-workspace.ts) to avoid a cross-file coupling for what is a thin,
 * decoupled write-through helper.
 */

import { getDriftDb } from "@platform/storage/drift/drift-db-cache.ts";

export type RegisterActiveWorkspaceInput = {
  workspace: string;
  lock_gated?: boolean;
  slug: string;
  base_commit: string;
  session_id?: string;
  job_id?: string;
};

/**
 * Register a workspace as `live` in the project-level active-workspaces
 * registry. Fail-open (decision registry-store-location-02.md): a registry
 * write must NEVER block workspace creation or resume — mirrors the
 * reconcile-workspace.ts writeCliffEventsThrough fail-open idiom.
 * No-op for lock-gated results (nothing was actually created/resumed).
 */
export function tryRegisterActiveWorkspace(
  projectDir: string,
  input: RegisterActiveWorkspaceInput,
): void {
  if (!input.workspace || input.lock_gated) return;
  try {
    getDriftDb(projectDir).getActiveWorkspaces().register({
      base_commit: input.base_commit,
      job_id: input.job_id,
      session_id: input.session_id,
      slug: input.slug,
      workspace_path: input.workspace,
    });
  } catch (err) {
    console.warn(
      "[init-workspace] active-workspaces registry write failed:",
      err instanceof Error ? err.message : err,
    );
  }
}

// Structural (duck-typed) shapes so init-workspace.ts's InitWorkspaceInput /
// InitWorkspaceResult / Session satisfy these without an import — keeps this
// module decoupled while still giving init-workspace.ts a one-line call site.
type InitLikeInput = { base_commit: string; session_id?: string; job_id?: string };
type ResultLike = { workspace: string; lock_gated?: boolean };
type SessionLike = { slug: string };

/** One-line convenience wrapper for the two initWorkspaceFlow call sites (resume + create). */
export function registerFromInit(
  projectDir: string,
  input: InitLikeInput,
  result: ResultLike,
  session: SessionLike,
): void {
  tryRegisterActiveWorkspace(projectDir, {
    base_commit: input.base_commit,
    job_id: input.job_id,
    lock_gated: result.lock_gated,
    session_id: input.session_id,
    slug: session.slug,
    workspace: result.workspace,
  });
}
