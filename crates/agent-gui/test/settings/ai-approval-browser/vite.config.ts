import path from "node:path";
import { defineConfig, mergeConfig } from "vite";
import gui from "../../../vite.config";
export default defineConfig(async (env) => mergeConfig(await gui(env), {
  root: path.resolve(__dirname),
  cacheDir: path.resolve(__dirname, ".vite"),
  server: { host: "127.0.0.1", port: 18477, strictPort: true,
    fs: { allow: [path.resolve(__dirname, "../../../../..")] },
  },
}));
