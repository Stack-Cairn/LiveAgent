import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import Icons from "unplugin-icons/vite";
import path from "node:path";
const gui = path.resolve(__dirname, "..");
export default defineConfig({
  root: __dirname,
  // Never share node_modules/.vite with the developer's running dev server.
  cacheDir: "/tmp/planning-harness-vite-cache",
  plugins: [react(), Icons({ compiler: "jsx", jsx: "react" })],
  resolve: { dedupe: ["react", "react-dom"], alias: [
    { find: "@liveagent/app/lib/planning/backend", replacement: path.resolve(__dirname, "mockBackend.ts") },
    { find: "@liveagent/app/lib/automation/backend", replacement: path.resolve(__dirname, "mockAutomation.ts") },
    { find: "@liveagent/app/lib/notifications/backend", replacement: path.resolve(__dirname, "mockNotifications.ts") },
    { find: "@liveagent/app", replacement: path.resolve(gui, "src") },
    { find: "@liveagent/adapters", replacement: path.resolve(gui, "src/agent-ui-adapters") },
    { find: "@liveagent/ui", replacement: path.resolve(gui, "../agent-ui/src") },
    { find: "node:fs", replacement: path.resolve(gui, "../agent-ui/src/shims/nodeFs.ts") } ] },
  define: { __LIVEAGENT_APP_VERSION__: '"dev"' },
  server: { port: 1488, strictPort: true, fs: { allow: [path.resolve(gui, "../..")] } },
});
