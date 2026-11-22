// Production build of the transcript performance harness (see run.mjs).
// Mirrors the app's aliases and plugins, and swaps in React's profiling
// renderer so <Profiler> callbacks fire in a production bundle. PERF_PLAIN=1
// keeps the regular production renderer (no commit counts, no profiling
// overhead) and writes to dist-plain/.
import { readFileSync } from "node:fs";
import path from "node:path";
import react from "@vitejs/plugin-react";
import Icons from "unplugin-icons/vite";
import { defineConfig } from "vite";

const appRoot = path.resolve(__dirname, "..");
const plain = process.env.PERF_PLAIN === "1";
const packageJson = JSON.parse(readFileSync(path.join(appRoot, "package.json"), "utf8")) as {
  version?: string;
};

export default defineConfig({
  root: __dirname,
  base: "./",
  plugins: [react(), Icons({ compiler: "jsx", jsx: "react" })],
  css: { postcss: appRoot },
  resolve: {
    dedupe: ["react", "react-dom"],
    alias: [
      ...(plain ? [] : [{ find: /^react-dom\/client$/, replacement: "react-dom/profiling" }]),
      { find: "@liveagent/app", replacement: path.join(appRoot, "src") },
      { find: "@liveagent/adapters", replacement: path.join(appRoot, "src/agent-ui-adapters") },
      { find: "@liveagent/ui", replacement: path.resolve(appRoot, "../agent-ui/src") },
      { find: "node:fs", replacement: path.resolve(appRoot, "../agent-ui/src/shims/nodeFs.ts") },
    ],
  },
  define: {
    __LIVEAGENT_APP_VERSION__: JSON.stringify(packageJson.version ?? "0.0.0"),
  },
  build: {
    outDir: path.join(__dirname, plain ? "dist-plain" : "dist"),
    emptyOutDir: true,
    chunkSizeWarningLimit: 20_000,
    // PERF_NO_MINIFY=1 keeps function names readable in CPU profiles.
    minify: process.env.PERF_NO_MINIFY !== "1",
    rolldownOptions: {
      input: path.join(__dirname, "transcript.html"),
      output: { codeSplitting: false },
    },
  },
  logLevel: "warn",
});
