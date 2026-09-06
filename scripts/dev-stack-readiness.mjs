import { realpathSync } from "node:fs";
import { join } from "node:path";

export function matchesDesktopBackend(data, repoRoot, requireVisible = false) {
  if (data?.app?.identifier !== "com.xiaofei.liveagent" || !data?.environment?.debug) return false;
  try {
    if (realpathSync(data.cwd) !== realpathSync(join(repoRoot, "crates/agent-gui/src-tauri")))
      return false;
  } catch {
    return false;
  }
  return (
    Array.isArray(data.windows) &&
    data.windows.some(
      (window) => window.label === "main" && (!requireVisible || window.visible === true),
    )
  );
}

// Vite can answer HTTP while Cargo is still compiling (or has already failed).
// The debug bridge identifies the native process by its actual checkout and,
// during initial startup, confirms that the frontend has revealed its window.
export function desktopBackendReady(repoRoot, port, requireVisible = false) {
  return new Promise((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    let finished = false;
    const finish = (ready) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      socket.close();
      resolve(ready);
    };
    const timeout = setTimeout(() => finish(false), 2000);
    socket.onerror = () => finish(false);
    socket.onclose = () => finish(false);
    socket.onopen = () =>
      socket.send(
        JSON.stringify({
          id: "dev-stack-ready",
          command: "invoke_tauri",
          args: { command: "plugin:mcp-bridge|get_backend_state", args: {} },
        }),
      );
    socket.onmessage = (event) => {
      try {
        const result = JSON.parse(event.data);
        if (result.id !== "dev-stack-ready") return;
        finish(
          result.success === true && matchesDesktopBackend(result.data, repoRoot, requireVisible),
        );
      } catch {
        finish(false);
      }
    };
  });
}
