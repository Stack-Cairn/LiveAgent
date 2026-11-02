import type { AIApprovalReadinessState } from "@liveagent/ui/lib/settings/aiApprovalReadiness";
import { kbrainSettingsAdapter } from "./kbrainSettings";

/** Desktop: read the reviewer configuration straight from the local K-brain; null when it has none. */
export async function loadAIApprovalState(): Promise<AIApprovalReadinessState | null> {
  const document = await kbrainSettingsAdapter.getSettings();
  return document.aiApproval
    ? { aiApproval: document.aiApproval, models: document.models ?? [] }
    : null;
}
