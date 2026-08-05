import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import Icons from "unplugin-icons/vite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

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

  // 阶段 4 的收口点：`invoke` 和 `listen` 换成我们自己的实现，于是 57 个
  // 直接 import @tauri-apps/api 的文件一行不改就从 IPC 换到了网络。
  //
  // 为什么必须在这一层拦：Tauri v2 的注入脚本用
  // `Object.defineProperty(window, '__TAURI_INTERNALS__', { value })` 定义
  // internals 和它的 invoke，全部 non-writable + non-configurable，运行时
  // 包不了。tsconfig.json 的 paths 里有同样两条，让漏掉的导出变成编译错误。
  //
  // 注意 alias 匹配的是裸 specifier，包内部的相对 import（@tauri-apps/api/
  // window 引用 ./core.js）不受影响——那些本来就该走壳。
  resolve: {
    alias: [
      {
        find: "@tauri-apps/api/core",
        replacement: fileURLToPath(new URL("./src/lib/backend/tauriCore.ts", import.meta.url)),
      },
      {
        find: "@tauri-apps/api/event",
        replacement: fileURLToPath(new URL("./src/lib/backend/tauriEvent.ts", import.meta.url)),
      },
      {
        find: "@tauri-apps/plugin-opener",
        replacement: fileURLToPath(new URL("./src/lib/backend/tauriOpener.ts", import.meta.url)),
      },
    ],
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
