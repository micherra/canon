/**
 * useDataLoader.svelte.ts
 *
 * A composable that manages the lifecycle of an async data-loading operation.
 * Callers provide a `loader` function that returns a Promise<T>; this
 * composable handles the status transitions (loading → done | error) and
 * exposes the result as reactive rune state.
 *
 * Canonical usage (use $derived aliasing so all reactive reads are explicit):
 *
 *   const loader = useDataLoader(() => bridge.callTool("get_drift_report"));
 *   let status = $derived(loader.status);
 *   let data   = $derived(loader.data);
 *   let errorMsg = $derived(loader.errorMsg);
 *
 * Then read `status`, `data`, and `errorMsg` directly in templates and other
 * $derived expressions. This pattern makes reactivity boundaries obvious and
 * composes cleanly with additional $derived/$state declarations in the same
 * component.
 *
 * The loader is invoked once immediately on composable creation. An
 * AbortController is used internally; if the component unmounts before the
 * load completes, the abort fires and stale results are dropped from state.
 *
 * For Svelte 5 rune reactivity this file must use the `.svelte.ts` extension.
 *
 * Canon principles:
 *   - props-are-the-component-contract: loader is the only coupling point
 *   - single-source-of-truth: one status field; no redundant booleans
 */

export type LoaderStatus = "loading" | "done" | "error";

export type DataLoaderState<T> = {
  readonly status: LoaderStatus;
  readonly data: T | null;
  readonly errorMsg: string;
};

export function useDataLoader<T>(loader: () => Promise<T>): DataLoaderState<T> {
  let status = $state<LoaderStatus>("loading");
  let data = $state<T | null>(null);
  let errorMsg = $state<string>("");

  async function runLoader(signal: AbortSignal): Promise<void> {
    try {
      const result = await loader();
      if (signal.aborted) return;
      data = result;
      status = "done";
    } catch (err: unknown) {
      if (signal.aborted) return;
      errorMsg = err instanceof Error ? err.message : String(err);
      status = "error";
    }
  }

  $effect(() => {
    const controller = new AbortController();
    runLoader(controller.signal);
    return () => controller.abort();
  });

  // Return a plain object backed by rune state. Because $state is reactive,
  // any Svelte component reading these properties will re-render on change.
  return {
    get data() {
      return data;
    },
    get errorMsg() {
      return errorMsg;
    },
    get status() {
      return status;
    },
  };
}
