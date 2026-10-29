import type { AIApprovalReadinessState } from "@liveagent/ui/lib/settings/aiApprovalReadiness";
import { settingsHostAdapter } from "./settingsExtension";

/**
 * WebUI: read the reviewer configuration the Gateway relays; null (unknown)
 * when the connected desktop or backend does not report one.
 */
export async function loadAIApprovalState(): Promise<AIApprovalReadinessState | null> {
  const document = await settingsHostAdapter.kbrain.getSettings();
  return document.aiApproval
    ? { aiApproval: document.aiApproval, models: document.models ?? [] }
    : null;
}
