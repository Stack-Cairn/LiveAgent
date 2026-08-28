import { createSessionWorkbenchFeature } from "@liveagent/ui/lib/workbench/featureFlags";

// Web 端与桌面端共用同一个逃生开关：VITE_LIVEAGENT_SESSION_WORKBENCH=0 回退单 Pane。
export const sessionWorkbench = createSessionWorkbenchFeature(
  import.meta.env.VITE_LIVEAGENT_SESSION_WORKBENCH,
);
