import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import Icons from "unplugin-icons/vite";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const projectRoot = path.dirname(new URL(import.meta.url).pathname);
const packageJson = JSON.parse(
  readFileSync(path.join(projectRoot, "package.json"), "utf8"),
) as { version?: string };

// @ts-expect-error process is a nodejs global
const env = process.env as Record<string, string | undefined>;
const appVersion = env.LIVEAGENT_APP_VERSION?.trim() || packageJson.version || "0.0.0";
const host = env.TAURI_DEV_HOST;

// Pin the workspace root so `unplugin-icons` resolves @iconify-json/* even
// when `vite` is launched from `crates/agent-gui/src-tauri/` (Tauri runs
// `beforeDevCommand` from the config directory, which sits one level below
// the package.json). CUA-008: without this, every `~icons/lucide/*` import
// fails with "Icon not found" and the SPA renders the ErrorOverlay.
const iconifyCollectionsNodeResolvePath = [
  path.join(projectRoot, "node_modules"),
  path.join(projectRoot, "../node_modules"),
  path.join(projectRoot, "../../node_modules"),
].filter((candidate) => existsSync(candidate));

// https://vite.dev/config/
export default defineConfig(async () => ({
  root: projectRoot,
  plugins: [
    react(),
    Icons({
      compiler: "jsx",
      jsx: "react",
      // Hint unplugin-icons at the workspace's iconify-json directories so
      // it never has to fall back to cwd-relative discovery.
      ...(iconifyCollectionsNodeResolvePath.length > 0
        ? { collectionsNodeResolvePath: iconifyCollectionsNodeResolvePath }
        : {}),
    }),
  ],
  resolve: {
    dedupe: ["react", "react-dom"],
    alias: {
      "@liveagent/app": path.resolve(projectRoot, "./src"),
      "@liveagent/adapters": path.resolve(projectRoot, "./src/agent-ui-adapters"),
      "@liveagent/ui": path.resolve(projectRoot, "../agent-ui/src"),
      "node:fs": path.resolve(projectRoot, "../agent-ui/src/shims/nodeFs.ts"),
    },
  },
  define: {
    __LIVEAGENT_APP_VERSION__: JSON.stringify(appVersion),
  },
  build: {
    // Monaco language workers are emitted as indivisible lazy assets (largest
    // is the TypeScript worker at ~6.6 MB). Bump the warning limit so those
    // known-large chunks don't drown out real regressions in the console.
    chunkSizeWarningLimit: 7_000,
    // NOTE: a previous build config set `rolldownOptions.output.codeSplitting`
    // with a `liveagent-app` group. That custom chunking split the
    // `style-to-js → style-to-object → inline-style-parser` CommonJS interop
    // chain across chunks, and rolldown's `__commonJSMin` thunks failed to
    // initialize across the chunk boundary — the release bundle crashed at
    // render time with "require_cjs$N is not a function" (black screen), while
    // `tauri dev` (no chunk splitting) worked. Disabled here to fall back to
    // rolldown's default automatic chunking, which keeps that CJS chain intact.
    rolldownOptions: {
      output: {
        codeSplitting: false,
      },
    },
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
