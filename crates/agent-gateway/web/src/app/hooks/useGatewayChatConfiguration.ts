import { t as translate } from "@liveagent/ui/i18n/index";
import { useComposerSkillSelection } from "@liveagent/ui/lib/chat/useComposerActions";
import { useThinkingLiveVersion } from "@liveagent/ui/lib/models/useThinkingLive";
import { useChatSkills } from "@liveagent/ui/lib/skills/useChatSkills";
import type { Dispatch, SetStateAction } from "react";
import { useCallback, useMemo } from "react";

import { buildModelOptions } from "@/lib/chat/chatPageHelpers";
import { toModelValue } from "@/lib/providers/llm";
import {
  type AppSettings,
  applyConversationThinking,
  applyThinkingPatchToSelection,
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
    if (!activeSelectedModel) return translate("chat.selectModel", settings.locale);
    const provider = activeProviders.find(
      (item) => item.id === activeSelectedModel.customProviderId,
    );
    return provider ? `${provider.name} / ${activeSelectedModel.model}` : activeSelectedModel.model;
  }, [activeProviders, activeSelectedModel, settings.locale]);
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
  // 运行期思考档位补充到达会改变档位列表/恒开判定，版本号计入依赖使 memo 跟进。
  const thinkingLiveVersion = useThinkingLiveVersion();
  // biome-ignore lint/correctness/useExhaustiveDependencies: thinkingLiveVersion 是刻意的失效信号，运行期档位补充到达后重算。
  const chatRuntimeReasoningOptions = useMemo(
    () =>
      getChatRuntimeReasoningLevelsForProvider({
        providerId: currentChatProvider?.type,
        requestFormat: currentChatProvider?.requestFormat,
        modelId: activeSelectedModel?.model,
      }),
    [
      activeSelectedModel?.model,
      currentChatProvider?.requestFormat,
      currentChatProvider?.type,
      thinkingLiveVersion,
    ],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: thinkingLiveVersion 是刻意的失效信号，运行期档位补充到达后重算。
  const chatRuntimeThinkingAlwaysOn = useMemo(
    () =>
      isThinkingAlwaysOnForModel(
        currentChatProvider?.type ?? "claude_code",
        activeSelectedModel?.model,
      ),
    [activeSelectedModel?.model, currentChatProvider?.type, thinkingLiveVersion],
  );
  // normalizeChatRuntimeControlsForProvider 会按模型档位表钳制当前选中档：档位表
  // 随运行期补充变化时，选中档必须同步重钳，否则出现「选中档不在选项里」。
  // biome-ignore lint/correctness/useExhaustiveDependencies: thinkingLiveVersion 是刻意的失效信号，运行期档位补充到达后重钳当前档。
  const chatRuntimeControlsForCurrentProvider = useMemo(
    () =>
      normalizeChatRuntimeControlsForProvider(
        applyConversationThinking(settings.chatRuntimeControls, activeSelectedModel),
        {
          providerId: currentChatProvider?.type,
          requestFormat: currentChatProvider?.requestFormat,
          modelId: activeSelectedModel?.model,
        },
      ),
    [
      activeSelectedModel,
      currentChatProvider?.requestFormat,
      currentChatProvider?.type,
      settings.chatRuntimeControls,
      thinkingLiveVersion,
    ],
  );
  const handleChatRuntimeControlsChange = useCallback(
    (patch: Partial<ChatRuntimeControls>) => {
      // 思考调整保存到本会话的选择（随下一次发送写入会话历史）；
      // 全局设置继续记录最近的调整，作为新会话的默认值。
      const selection = applyThinkingPatchToSelection(
        activeSelectedModel,
        chatRuntimeControlsForCurrentProvider,
        patch,
      );
      const targetConversationId = displayedConversationId.trim();
      if (selection && targetConversationId) {
        setConversationModelOverrides((prev) => new Map(prev).set(targetConversationId, selection));
      }
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
      activeSelectedModel,
      chatRuntimeControlsForCurrentProvider,
      currentChatProvider?.requestFormat,
      currentChatProvider?.type,
      displayedConversationId,
      setConversationModelOverrides,
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
          // 切换模型保留会话已有的思考设置；全局默认只记录模型。
          next.set(targetConversationId, { ...activeSelectedModel, ...selection });
          return next;
        });
      }
      setSettings((prev) => setSelectedModel(prev, selection));
    },
    [activeSelectedModel, displayedConversationId, setConversationModelOverrides, setSettings],
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
