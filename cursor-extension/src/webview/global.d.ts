/// <reference types="svelte" />

declare const d3: typeof import("d3");
declare const marked: { parse(src: string): string };

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

// Allow .svelte imports in TypeScript
declare module "*.svelte" {
  import type { ComponentType, SvelteComponent } from "svelte";
  const component: ComponentType<SvelteComponent>;
  export default component;
}
