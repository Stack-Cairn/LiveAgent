import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function defaultDevStateDir(repoRoot, userKey) {
  // /tmp and /private/tmp can name the same macOS checkout.
  const checkout = realpathSync(repoRoot);
  const key = createHash("sha256").update(checkout).digest("hex").slice(0, 12);
  return join(tmpdir(), `liveagent-dev-stack-${userKey}-${key}`);
}

export function missingDevDependency(repoRoot, service) {
  const entries =
    service === "desktop"
      ? [
          "crates/agent-gui/node_modules/vite/bin/vite.js",
          "crates/agent-gui/node_modules/@tauri-apps/cli/tauri.js",
        ]
      : service === "webui"
        ? ["crates/agent-gateway/web/node_modules/vite/bin/vite.js"]
        : [];
  return entries.find((entry) => !existsSync(join(repoRoot, entry)));
}
