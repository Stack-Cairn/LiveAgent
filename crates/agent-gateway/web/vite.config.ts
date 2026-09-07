import path from "node:path";

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import Icons from "unplugin-icons/vite";

const DEFAULT_PROXY_API = "http://localhost:8080";

function resolveProxyTarget() {
  const cliArg = process.argv.find((arg) => arg.startsWith("--proxy-api="));
  if (cliArg) {
    return cliArg.slice("--proxy-api=".length) || DEFAULT_PROXY_API;
  }
  return process.env.npm_config_proxy_api || DEFAULT_PROXY_API;
}

export default defineConfig(() => ({
  plugins: [react(), Icons({ compiler: "jsx", jsx: "react" })],
  resolve: {
    dedupe: ["react", "react-dom"],
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@liveagent/app": path.resolve(__dirname, "./src"),
      "@liveagent/adapters": path.resolve(__dirname, "./src/agent-ui-adapters"),
      "@liveagent/ui": path.resolve(__dirname, "../../agent-ui/src"),
      "@tauri-apps/api/core": path.resolve(__dirname, "./src/shims/tauriCore.ts"),
      "@tauri-apps/api/event": path.resolve(__dirname, "./src/shims/tauriEvent.ts"),
      "@tauri-apps/plugin-opener": path.resolve(__dirname, "./src/shims/tauriOpener.ts"),
      "node:fs": path.resolve(__dirname, "../../agent-ui/src/shims/nodeFs.ts"),
      react: path.resolve(__dirname, "./node_modules/react"),
      "react/jsx-runtime": path.resolve(__dirname, "./node_modules/react/jsx-runtime.js"),
      "react/jsx-dev-runtime": path.resolve(__dirname, "./node_modules/react/jsx-dev-runtime.js"),
      "react-dom": path.resolve(__dirname, "./node_modules/react-dom"),
    },
  },
  optimizeDeps: {
    // @tanstack/react-virtual imports the vendored @tanstack/virtual-core
    // fork (crates/virtual-core, via the root pnpm override). Pre-bundling
    // the adapter inlines the fork's source into node_modules/.vite, where
    // it is keyed on the lockfile/config only — edits to the fork would
    // silently keep running the stale copy until a `--force`. Serve it as
    // source instead so the fork is always live (and HMR-able) in dev.
    exclude: ["@tanstack/react-virtual"],
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // Monaco language workers are emitted as indivisible lazy assets (largest
    // is the TypeScript worker at ~6.6 MB). Bump the warning limit so those
    // known-large chunks don't drown out real regressions in the console.
    chunkSizeWarningLimit: 7_000,
    // Do not restore `rolldownOptions.output.codeSplitting` with a
    // `liveagent-webui` group / `maxSize: 450_000`. That size-based split cut
    // `GatewayTerminalStreamHandle extends TerminalStreamBuffer` across chunks
    // and created a circular ESM cycle, crashing load with
    // "Class extends value undefined is not a constructor or null".
    // `codeSplitting: false` (used by the GUI in #613) inlines every overlay
    // into a ~23 MB main bundle, which is fine for Tauri but not for WebUI.
  },
  server: {
    proxy: {
      "/api": {
        target: resolveProxyTarget(),
        changeOrigin: true,
      },
      "/ws": {
        target: resolveProxyTarget(),
        changeOrigin: true,
        ws: true,
      },
      "/image-proxy": {
        target: resolveProxyTarget(),
        changeOrigin: true,
      },
    },
  },
}));
