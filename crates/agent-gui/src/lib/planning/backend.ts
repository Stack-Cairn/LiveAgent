import type { PlanningBackend } from "@liveagent/ui/lib/planning/types";
import { kBrainStorageScope } from "../kbrain/mapping";
import { requestPlanning } from "./kbrain";
export const backend: PlanningBackend = {
  scope: () => kBrainStorageScope(),
  call: requestPlanning,
  subscribe(listener) {
    const timer = setInterval(() => listener(), 2_000);
    const refresh = () => listener();
    window.addEventListener("focus", refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  },
};
