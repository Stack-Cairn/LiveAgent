import type {
  AutomationApplyInput,
  HooksApplyResponse,
  HooksSnapshot,
} from "@liveagent/ui/lib/automation/types";
import { fetchKBrain } from "../kbrain/transport";

async function request<T>(method: string, input?: AutomationApplyInput): Promise<T> {
  const response = await fetchKBrain("/v1/hooks", {
    method,
    headers: {
      Accept: "application/json",
      ...(input ? { "Content-Type": "application/json" } : {}),
    },
    ...(input ? { body: JSON.stringify(input) } : {}),
  });
  if (!response.ok)
    throw new Error(`K-brain hooks request failed (${response.status}): ${await response.text()}`);
  return response.json() as Promise<T>;
}

export const fetchKBrainHooks = () => request<HooksSnapshot>("GET");
export const applyKBrainHooks = (input: AutomationApplyInput) =>
  request<HooksApplyResponse>("PUT", input);
