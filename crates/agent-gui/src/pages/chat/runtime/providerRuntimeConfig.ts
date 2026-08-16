import { createProviderRuntimeConfig } from "../../../lib/providers/runtime/providerRuntimeConfig";
import type { ProviderRuntimeConfig } from "../../../lib/providers/runtime/types";
import type { AppSettings, ChatRuntimeControls, SelectedModel } from "../../../lib/settings";
import type { EffectiveChatModelSelection } from "./modelSelection";

export function resolveMemorySummaryModelSelection(
  settings: AppSettings,
): EffectiveChatModelSelection | null {
  const summaryModel = settings.memory.summaryModel;
  if (!summaryModel) {
    return null;
  }

  const provider = settings.customProviders.find(
    (item) => item.id === summaryModel.customProviderId,
  );
  if (!provider || !provider.activeModels.includes(summaryModel.model)) {
    return null;
  }

  return {
    selectedModel: summaryModel,
    provider,
    providerId: provider.type,
    model: summaryModel.model,
  };
}

export function resolveConversationTitleModelSelection(
  settings: AppSettings,
  fallback: EffectiveChatModelSelection,
): EffectiveChatModelSelection {
  const titleModel = settings.customSettings.conversationTitleModel;
  if (!titleModel) {
    return fallback;
  }

  const provider = settings.customProviders.find((item) => item.id === titleModel.customProviderId);
  if (!provider || !provider.activeModels.includes(titleModel.model)) {
    return fallback;
  }

  return {
    selectedModel: titleModel,
    provider,
    providerId: provider.type,
    model: titleModel.model,
  };
}

// Commit-message generation model for the Git review dock. Returns null when
// the setting is unset or points at a provider/model that is no longer active,
// so the caller falls back to the current conversation model.
export function resolveCommitMessageModelSelection(
  settings: AppSettings,
): EffectiveChatModelSelection | null {
  const commitModel = settings.customSettings.commitMessageModel;
  if (!commitModel) {
    return null;
  }

  const provider = settings.customProviders.find(
    (item) => item.id === commitModel.customProviderId,
  );
  if (!provider || !provider.activeModels.includes(commitModel.model)) {
    return null;
  }

  return {
    selectedModel: commitModel,
    provider,
    providerId: provider.type,
    model: commitModel.model,
  };
}

export function selectedModelsMatch(
  left: SelectedModel | undefined,
  right: SelectedModel | undefined,
) {
  return (
    Boolean(left) &&
    Boolean(right) &&
    left?.customProviderId === right?.customProviderId &&
    left?.model === right?.model
  );
}

export type ModelFailoverPlan = {
  config: {
    maxSwitches: number;
    failureThreshold: number;
    cooldownSeconds: number;
  };
  primary: { selectedModel: SelectedModel; label: string };
  fallbacks: {
    selectedModel: SelectedModel;
    providerId: AppSettings["customProviders"][number]["type"];
    model: string;
    label: string;
    runtime: ProviderRuntimeConfig;
  }[];
};

export function failoverTargetLabel(providerName: string, model: string) {
  return `${providerName} · ${model}`;
}

/**
 * Resolves settings.modelFailover into concrete fallback targets for one turn.
 * Failover is vendor-scoped (cc-switch style Claude→Claude / Codex→Codex):
 * the plan reads the provider queue configured for the active provider's
 * vendor type, and only same-vendor providers qualify as fallbacks — never
 * cross-vendor. Each fallback re-sends the conversation's *own model id* to
 * the queued provider (cc-switch semantics: switch provider, keep model);
 * queued providers that don't have that model active are skipped for this
 * turn. The active selection stays first (LiveAgent keeps the user's
 * per-conversation choice, unlike cc-switch's always-P1 routing); queue
 * entries that duplicate the active provider are dropped. Returns undefined
 * when failover is off for this vendor or nothing remains to fail over to.
 */
export function buildModelFailoverPlan(
  settings: AppSettings,
  primary: EffectiveChatModelSelection,
  controlsInput?: ChatRuntimeControls,
): ModelFailoverPlan | undefined {
  const failover = settings.modelFailover?.[primary.providerId];
  if (!failover?.enabled || failover.queue.length === 0) {
    return undefined;
  }

  const fallbacks: ModelFailoverPlan["fallbacks"] = [];
  for (const providerId of failover.queue) {
    if (providerId === primary.selectedModel.customProviderId) continue;
    const provider = settings.customProviders.find((item) => item.id === providerId);
    // The fallback must host the conversation's model: failover keeps the
    // model id and only changes which provider serves it.
    if (!provider || !provider.activeModels.includes(primary.model)) continue;
    // Same-vendor guard: normalization already filters cross-vendor queue
    // entries, but re-check here so a stale persisted queue can never route
    // a Claude request to a Codex provider (or vice versa).
    if (provider.type !== primary.providerId) continue;
    if (!provider.baseUrl.trim() || !provider.apiKey.trim()) continue;
    fallbacks.push({
      selectedModel: { customProviderId: provider.id, model: primary.model },
      providerId: provider.type,
      model: primary.model,
      label: failoverTargetLabel(provider.name, primary.model),
      runtime: createProviderRuntimeConfig(provider, primary.model, controlsInput),
    });
  }
  if (fallbacks.length === 0) {
    return undefined;
  }

  return {
    config: {
      maxSwitches: failover.maxSwitches,
      failureThreshold: failover.failureThreshold,
      cooldownSeconds: failover.cooldownSeconds,
    },
    primary: {
      selectedModel: primary.selectedModel,
      label: failoverTargetLabel(primary.provider.name, primary.model),
    },
    fallbacks,
  };
}
