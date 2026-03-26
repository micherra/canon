/**
 * useDataLoader.svelte.ts
 *
 * A composable that manages the lifecycle of an async data-loading operation.
 * Callers provide a `loader` function that returns a Promise<T>; this
 * composable handles the status transitions (loading → done | error) and
 * exposes the result as reactive rune state.
 *
 * Usage:
 *   const state = useDataLoader(() => bridge.callTool("get_drift_report"));
 *   // state.status: "loading" | "done" | "error"
 *   // state.data: T | null
 *   // state.errorMsg: string
 *
 * The loader is invoked once immediately on composable creation. For
 * Svelte 5 rune reactivity this file must use the `.svelte.ts` extension.
 *
 * Canon principles:
 *   - props-are-the-component-contract: loader is the only coupling point
 *   - single-source-of-truth: one status field; no redundant booleans
 */

export type LoaderStatus = "loading" | "done" | "error";

export interface DataLoaderState<T> {
  readonly status: LoaderStatus;
  readonly data: T | null;
  readonly errorMsg: string;
}

export function useDataLoader<T>(loader: () => Promise<T>): DataLoaderState<T> {
  let status = $state<LoaderStatus>("loading");
  let data = $state<T | null>(null);
  let errorMsg = $state<string>("");

  // Kick off the load immediately. Svelte 5 $state is synchronously readable
  // after creation, so this IIFE runs once and mutates state reactively.
  (async () => {
    try {
      const result = await loader();
      data = result;
      status = "done";
    } catch (err: unknown) {
      errorMsg = err instanceof Error ? err.message : String(err);
      status = "error";
    }
  })();

  // Return a plain object backed by rune state. Because $state is reactive,
  // any Svelte component reading these properties will re-render on change.
  return {
    get status() { return status; },
    get data() { return data; },
    get errorMsg() { return errorMsg; },
  };
}
