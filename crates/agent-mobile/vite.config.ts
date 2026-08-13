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
      "@liveagent/ui": path.resolve(__dirname, "../agent-ui/src"),
      "@tauri-apps/api/core": path.resolve(__dirname, "./src/shims/tauriCore.ts"),
      "@tauri-apps/api/event": path.resolve(__dirname, "./src/shims/tauriEvent.ts"),
      "@tauri-apps/plugin-opener": path.resolve(__dirname, "./src/shims/tauriOpener.ts"),
      react: path.resolve(__dirname, "./node_modules/react"),
      "react/jsx-runtime": path.resolve(__dirname, "./node_modules/react/jsx-runtime.js"),
      "react/jsx-dev-runtime": path.resolve(__dirname, "./node_modules/react/jsx-dev-runtime.js"),
      "react-dom": path.resolve(__dirname, "./node_modules/react-dom"),
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
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
