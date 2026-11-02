import {
  type AppSettings,
  resolvePromptClarifyModel,
  type SelectedModel,
} from "../../../lib/settings";
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
  if (!provider?.activeModels.includes(summaryModel.model)) {
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
  if (!provider?.activeModels.includes(titleModel.model)) {
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
  if (!provider?.activeModels.includes(commitModel.model)) {
    return null;
  }

  return {
    selectedModel: commitModel,
    provider,
    providerId: provider.type,
    model: commitModel.model,
  };
}

// Prompt-clarify model override (设置抽屉「澄清对话模型」). Returns null when
// unset or stale so the caller falls back to the current conversation model —
// same contract as resolveCommitMessageModelSelection, validation shared with
// the web surface via resolvePromptClarifyModel.
export function resolvePromptClarifyModelSelection(
  settings: AppSettings,
): EffectiveChatModelSelection | null {
  const resolved = resolvePromptClarifyModel(settings);
  if (!resolved) {
    return null;
  }
  return {
    selectedModel: { customProviderId: resolved.provider.id, model: resolved.model },
    provider: resolved.provider,
    providerId: resolved.provider.type,
    model: resolved.model,
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
