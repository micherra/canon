import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { viteSingleFile } from "vite-plugin-singlefile";

const INPUT = process.env.INPUT;
if (!INPUT) throw new Error("INPUT environment variable is not set");

export default defineConfig({
  plugins: [svelte(), viteSingleFile()],
  build: {
    sourcemap: process.env.NODE_ENV === "development" ? "inline" : undefined,
    rollupOptions: { input: INPUT },
    outDir: "dist",
    emptyOutDir: false,
  },
});
