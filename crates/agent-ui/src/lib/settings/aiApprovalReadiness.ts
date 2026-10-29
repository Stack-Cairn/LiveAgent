import type {
  AIApprovalConfig,
  KBrainSettingsModel,
} from "@liveagent/ui/pages/settings/kbrainSettingsAdapter";
import { useEffect, useState } from "react";

/** The reviewer configuration and the models K-brain can currently route to. */
export type AIApprovalReadinessState = {
  aiApproval: AIApprovalConfig;
  models: readonly Pick<KBrainSettingsModel, "provider" | "id">[];
};

const SETTINGS_CHANGED_EVENT = "kbrain:settings-changed";

/**
 * K-brain reviews actions only with a reviewer provider and model it can route
 * to (internal/approval/reviewer.go, internal/routing). A deleted provider or a
 * deactivated model keeps its stale config, so availability uses the same rule
 * as the AI approval settings section: the pair must be among the models.
 * Without a usable reviewer every review is "unknown": auto review then asks
 * for every action and withholds tool output.
 */
export function isAIApprovalReviewerConfigured(state: AIApprovalReadinessState) {
  const provider = state.aiApproval.provider?.trim();
  const model = state.aiApproval.model?.trim();
  return Boolean(
    provider &&
      model &&
      state.models.some((item) => item.provider === provider && item.id === model),
  );
}

/**
 * Whether a usable reviewer is configured. While `active`, it is read again
 * whenever `refreshKey` changes (for example each time a menu opens) and when
 * K-brain settings are saved elsewhere. null while unknown (loading, no backend
 * connection, a failed read, or a host that does not carry the configuration,
 * which `load` reports as null), so callers only warn on a confirmed gap.
 */
export function useAIApprovalReviewerConfigured(
  load: () => Promise<AIApprovalReadinessState | null>,
  active: boolean,
  refreshKey?: unknown,
): boolean | null {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [changes, setChanges] = useState(0);
  useEffect(() => {
    if (!active) return;
    const onChanged = () => setChanges((value) => value + 1);
    window.addEventListener(SETTINGS_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(SETTINGS_CHANGED_EVENT, onChanged);
  }, [active]);
  useEffect(() => {
    // refreshKey and changes only schedule a re-read; their values are unused.
    void refreshKey;
    void changes;
    if (!active) return;
    let disposed = false;
    load()
      .then((state) => {
        if (!disposed) setConfigured(state ? isAIApprovalReviewerConfigured(state) : null);
      })
      .catch(() => {
        if (!disposed) setConfigured(null);
      });
    return () => {
      disposed = true;
    };
  }, [active, load, refreshKey, changes]);
  return configured;
}
