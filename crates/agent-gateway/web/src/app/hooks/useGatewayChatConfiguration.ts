import { useComposerSkillSelection } from "@liveagent/ui/lib/chat/useComposerActions";
import { useChatSkills } from "@liveagent/ui/lib/skills/useChatSkills";
import type { Dispatch, SetStateAction } from "react";
import { useCallback, useMemo } from "react";

import { buildModelOptions } from "@/lib/chat/chatPageHelpers";
import { toModelValue } from "@/lib/providers/llm";
import {
  type AppSettings,
  type ChatRuntimeControls,
  findProviderModelConfig,
  getChatRuntimeReasoningLevelsForProvider,
  isAgentDevMode,
  isThinkingAlwaysOnForModel,
  normalizeChatRuntimeControlsForProvider,
  resolveWorkspaceResources,
  type SelectedModel,
  setSelectedModel,
  updateChatRuntimeControlsForProvider,
} from "@/lib/settings";

type UseGatewayChatConfigurationOptions = {
  activeSelectedModel: SelectedModel | undefined;
  displayedConversationId: string;
  isAgentMode: boolean;
  resourceWorkdir: string;
  setConversationModelOverrides: Dispatch<SetStateAction<ReadonlyMap<string, SelectedModel>>>;
  setSettings: (updater: (prev: AppSettings) => AppSettings) => void;
  settings: AppSettings;
};

export function useGatewayChatConfiguration({
  activeSelectedModel,
  displayedConversationId,
  isAgentMode,
  resourceWorkdir,
  setConversationModelOverrides,
  setSettings,
  settings,
}: UseGatewayChatConfigurationOptions) {
  const activeProviders = useMemo(() => settings.customProviders, [settings.customProviders]);
  const currentModelLabel = useMemo(() => {
    if (!activeSelectedModel) return "选择模型";
    const provider = activeProviders.find(
      (item) => item.id === activeSelectedModel.customProviderId,
    );
    return provider ? `${provider.name} / ${activeSelectedModel.model}` : activeSelectedModel.model;
  }, [activeProviders, activeSelectedModel]);
  const currentModelContextWindow = useMemo(() => {
    if (!activeSelectedModel) return undefined;
    const provider = settings.customProviders.find(
      (item) => item.id === activeSelectedModel.customProviderId,
    );
    return provider
      ? findProviderModelConfig(provider, activeSelectedModel.model).contextWindow
      : undefined;
  }, [activeSelectedModel, settings.customProviders]);
  const currentChatProvider = useMemo(() => {
    if (!activeSelectedModel) return undefined;
    return settings.customProviders.find(
      (item) => item.id === activeSelectedModel.customProviderId,
    );
  }, [activeSelectedModel, settings.customProviders]);
  const chatRuntimeReasoningOptions = useMemo(
    () =>
      getChatRuntimeReasoningLevelsForProvider({
        providerId: currentChatProvider?.type,
        requestFormat: currentChatProvider?.requestFormat,
        modelId: activeSelectedModel?.model,
      }),
    [activeSelectedModel?.model, currentChatProvider?.requestFormat, currentChatProvider?.type],
  );
  const chatRuntimeThinkingAlwaysOn = useMemo(
    () =>
      isThinkingAlwaysOnForModel(
        currentChatProvider?.type ?? "claude_code",
        activeSelectedModel?.model,
      ),
    [activeSelectedModel?.model, currentChatProvider?.type],
  );
  const chatRuntimeControlsForCurrentProvider = useMemo(
    () =>
      normalizeChatRuntimeControlsForProvider(settings.chatRuntimeControls, {
        providerId: currentChatProvider?.type,
        requestFormat: currentChatProvider?.requestFormat,
        modelId: activeSelectedModel?.model,
      }),
    [
      activeSelectedModel?.model,
      currentChatProvider?.requestFormat,
      currentChatProvider?.type,
      settings.chatRuntimeControls,
    ],
  );
  const handleChatRuntimeControlsChange = useCallback(
    (patch: Partial<ChatRuntimeControls>) => {
      setSettings((prev) => ({
        ...prev,
        chatRuntimeControls: updateChatRuntimeControlsForProvider(prev.chatRuntimeControls, patch, {
          providerId: currentChatProvider?.type,
          requestFormat: currentChatProvider?.requestFormat,
          modelId: activeSelectedModel?.model,
        }),
      }));
    },
    [
      activeSelectedModel?.model,
      currentChatProvider?.requestFormat,
      currentChatProvider?.type,
      setSettings,
    ],
  );
  const modelOptions = useMemo(
    () => buildModelOptions(settings, { floatSelectedFirst: false }),
    [settings],
  );
  const selectedValue = activeSelectedModel
    ? toModelValue(activeSelectedModel.customProviderId, activeSelectedModel.model)
    : undefined;
  const handleSelectModel = useCallback(
    (selection: SelectedModel) => {
      const targetConversationId = displayedConversationId.trim();
      if (targetConversationId) {
        setConversationModelOverrides((prev) => {
          const next = new Map(prev);
          next.set(targetConversationId, selection);
          return next;
        });
      }
      setSettings((prev) => setSelectedModel(prev, selection));
    },
    [displayedConversationId, setConversationModelOverrides, setSettings],
  );

  const workspaceResources = useMemo(
    () => resolveWorkspaceResources(settings, resourceWorkdir),
    [resourceWorkdir, settings],
  );
  const skillsEnabled = workspaceResources.skillsEnabled && isAgentMode;
  const selectedSkillNames = useMemo(
    () => (skillsEnabled ? workspaceResources.skillNames : []),
    [skillsEnabled, workspaceResources.skillNames],
  );
  const { availableSkills, skillsRootDir } = useChatSkills({
    skillsEnabled: settings.skills.enabled && isAgentMode,
    selectedSkillNames: settings.skills.selected,
    setSettings,
  });
  const { enabledComposerSkills, codeReviewSkill } = useComposerSkillSelection(
    availableSkills,
    selectedSkillNames,
    skillsEnabled,
  );

  return {
    activeProviders,
    availableSkills,
    chatRuntimeControlsForCurrentProvider,
    chatRuntimeReasoningOptions,
    chatRuntimeThinkingAlwaysOn,
    codeReviewSkill,
    currentChatProvider,
    currentModelContextWindow,
    currentModelLabel,
    enabledComposerSkills,
    handleChatRuntimeControlsChange,
    handleSelectModel,
    isAgentDevExecutionMode: isAgentDevMode(settings.system.executionMode),
    modelOptions,
    selectedSkillNames,
    selectedValue,
    skillsRootDir,
    workspaceResources,
  };
}
