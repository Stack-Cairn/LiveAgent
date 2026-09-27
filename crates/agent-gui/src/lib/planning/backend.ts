import type { PlanningBackend } from "@liveagent/ui/lib/planning/types";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
export const backend: PlanningBackend = {
  scope: () => "desktop",
  call<T>(action: string, input?: unknown): Promise<T> {
    switch (action) {
      case "query":
        return invoke("planning_query", { query: input ?? {} });
      case "mutate":
        return invoke("planning_mutate", { input });
      case "export":
        return invoke("planning_export");
      case "import":
        return invoke("planning_import", { snapshot: input });
      default:
        if (action.startsWith("subscription."))
          return invoke("planning_subscription", { action, input: input ?? {} });
        return Promise.reject(new Error("E:unknown_request"));
    }
  },
  subscribe(listener) {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<number>("planning:changed", ({ payload }) => listener(payload)).then((cleanup) => {
      if (disposed) cleanup();
      else unlisten = cleanup;
    });
    const timer = setInterval(() => listener(), 30_000);
    return () => {
      disposed = true;
      unlisten?.();
      clearInterval(timer);
    };
  },
};
