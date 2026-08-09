import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import Icons from "unplugin-icons/vite";
import { readFileSync } from "node:fs";
import path from "node:path";

const packageJson = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version?: string };

// @ts-expect-error process is a nodejs global
const env = process.env as Record<string, string | undefined>;
const appVersion = env.LIVEAGENT_APP_VERSION?.trim() || packageJson.version || "0.0.0";
const host = env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), Icons({ compiler: "jsx", jsx: "react" })],
  resolve: {
    dedupe: ["react", "react-dom"],
    alias: {
      "@liveagent/app": path.resolve(__dirname, "./src"),
      "@liveagent/adapters": path.resolve(__dirname, "./src/agent-ui-adapters"),
      "@liveagent/ui": path.resolve(__dirname, "../agent-ui/src"),
    },
  },
  define: {
    __LIVEAGENT_APP_VERSION__: JSON.stringify(appVersion),
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
