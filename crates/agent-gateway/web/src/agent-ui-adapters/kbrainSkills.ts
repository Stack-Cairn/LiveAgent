import type { SkillsResourceAdapter } from "@liveagent/ui/lib/resourceHost";
import { normalizeClawHubSkillCard } from "@liveagent/ui/lib/skills/clawHub";
import type { SystemManageSkillResponse } from "@liveagent/ui/lib/skills/index";
import { getGatewayWebSocketClient } from "../lib/gatewaySocket";
import { loadToken } from "../lib/storage";

async function request<T>(body: Record<string, unknown>): Promise<T> {
  return getGatewayWebSocketClient(loadToken().trim()).manageSkill<T>(body);
}

export const gatewaySkillsAdapter: SkillsResourceAdapter = {
  list: (workdir) => request({ action: "list", ...(workdir ? { workdir } : {}) }),
  settings: (body) => request({ ...body, action: "settings" }),
  read: (path, offset = 0, length = 200) => request({ action: "read", path, offset, length }),
  manage: async (body) => {
    const result = await request<SystemManageSkillResponse>(body);
    if (result.installJob?.phase === "completed") result.installJob.phase = "done";
    return result;
  },
  storeSearch: async (params) => {
    const result = await request<SystemManageSkillResponse>({
      ...params,
      action: "clawhub_search",
    });
    const items = (result.clawhubResults ?? []).map((raw) => {
      const item = normalizeClawHubSkillCard(raw);
      if (!item) throw new Error("Invalid K-brain skills store item");
      return item;
    });
    return { items, nextCursor: result.clawhubNextCursor ?? null };
  },
  storeInstall: (body) => request({ ...body, action: "clawhub_install" }),
};
