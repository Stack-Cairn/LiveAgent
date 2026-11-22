import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import Icons from "unplugin-icons/vite";
import { readFileSync } from "node:fs";
import path from "node:path";
import { lazyDiffHighlightGrammars } from "../agent-ui/build/lazyDiffGrammars";

const packageJson = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version?: string };

const env = process.env as Record<string, string | undefined>;
const appVersion = env.LIVEAGENT_APP_VERSION?.trim() || packageJson.version || "0.0.0";
const host = env.TAURI_DEV_HOST;
const desktopDevPort = Number(env.LIVEAGENT_DEV_DESKTOP_PORT || 1420);
if (!Number.isInteger(desktopDevPort) || desktopDevPort < 1 || desktopDevPort > 65534) {
  throw new Error("LIVEAGENT_DEV_DESKTOP_PORT must be an integer between 1 and 65534");
}

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), Icons({ compiler: "jsx", jsx: "react" }), lazyDiffHighlightGrammars()],
  resolve: {
    dedupe: ["react", "react-dom"],
    alias: {
      "@liveagent/app": path.resolve(__dirname, "./src"),
      "@liveagent/adapters": path.resolve(__dirname, "./src/agent-ui-adapters"),
      "@liveagent/ui": path.resolve(__dirname, "../agent-ui/src"),
      "node:fs": path.resolve(__dirname, "../agent-ui/src/shims/nodeFs.ts"),
    },
  },
  define: {
    __LIVEAGENT_APP_VERSION__: JSON.stringify(appVersion),
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
    // Monaco language workers are emitted as indivisible lazy assets (largest
    // is the TypeScript worker at ~6.6 MB). Bump the warning limit so those
    // known-large chunks don't drown out real regressions in the console.
    chunkSizeWarningLimit: 7_000,
    // Chunking: rolldown's default automatic splitting (one chunk per dynamic
    // import boundary plus shared chunks), with one pinned group.
    //
    // History: a custom `liveagent-app` group with `maxSize` once split the
    // `style-to-js → style-to-object → inline-style-parser` CommonJS interop
    // chain (pulled in by the markdown renderer via hast-util-to-jsx-runtime)
    // across chunks. rolldown's `__commonJSMin` thunks then failed to
    // initialize across the chunk boundary and the release bundle crashed at
    // render time with "require_cjs$N is not a function" (black screen) while
    // `tauri dev` worked. The bundle was then shipped as one 24 MB file.
    //
    // The `markdown-style-cjs` group keeps that whole chain (and its only
    // consumer) in a single chunk no matter how the rest is split. Do not add
    // size-based groups (`maxSize`/`minSize`) — they are what cut the chain.
    // `scripts/smoke-frontend-bundle.mjs` loads the built bundle in Chromium
    // and WebKit and imports every chunk; run it after changing this block.
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: "markdown-style-cjs",
              test: /[\\/]node_modules[\\/](?:\.pnpm[\\/][^\\/]+[\\/]node_modules[\\/])?(?:style-to-js|style-to-object|inline-style-parser|hast-util-to-jsx-runtime)[\\/]/,
            },
          ],
        },
      },
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: desktopDevPort,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: desktopDevPort + 1,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
