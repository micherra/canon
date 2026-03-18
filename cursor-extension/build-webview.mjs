import esbuild from "esbuild";
import sveltePlugin from "esbuild-svelte";

const watch = process.argv.includes("--watch");

const ctx = await esbuild.context({
  entryPoints: ["src/webview/main.ts"],
  bundle: true,
  outfile: "media/dashboard.js",
  format: "iife",
  platform: "browser",
  target: "es2020",
  // D3 and marked are loaded as globals via <script> tags in the HTML shell
  plugins: [
    sveltePlugin({
      compilerOptions: { css: "injected" },
    }),
  ],
  define: {
    "process.env.NODE_ENV": '"production"',
  },
  logLevel: "info",
});

if (watch) {
  await ctx.watch();
  console.log("[webview] watching for changes...");
} else {
  await ctx.rebuild();
  ctx.dispose();
}
